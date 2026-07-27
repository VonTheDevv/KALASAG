-- Make every family safety transition idempotent and serialize notification
-- delivery by recipient + family member. A stale danger notification may
-- finish first, but it can never be sent after its replacement/resolution.

BEGIN;

CREATE TABLE IF NOT EXISTS private.family_safety_client_events (
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_event_id uuid NOT NULL,
  safety_status text NOT NULL,
  result_alert_id uuid REFERENCES public.family_alerts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (family_id, user_id, client_event_id),
  CONSTRAINT family_safety_client_events_status_check
    CHECK (safety_status IN ('safe', 'unknown', 'in_danger'))
);

CREATE INDEX IF NOT EXISTS family_safety_client_events_created_idx
  ON private.family_safety_client_events (created_at);

REVOKE ALL ON TABLE private.family_safety_client_events
  FROM PUBLIC, anon, authenticated;

-- Backfill every previously accepted danger event so a delayed retry from an
-- already-installed client remains harmless after this migration.
INSERT INTO private.family_safety_client_events (
  family_id, user_id, client_event_id, safety_status, result_alert_id, created_at
)
SELECT
  event.family_id,
  event.user_id,
  event.client_event_id,
  'in_danger',
  event.alert_id,
  event.created_at
FROM private.family_alert_client_events AS event
ON CONFLICT (family_id, user_id, client_event_id) DO NOTHING;

CREATE SEQUENCE IF NOT EXISTS private.family_notification_display_sequence;
REVOKE ALL ON SEQUENCE private.family_notification_display_sequence
  FROM PUBLIC, anon, authenticated;

ALTER TABLE private.notification_outbox
  ADD COLUMN IF NOT EXISTS display_key text,
  ADD COLUMN IF NOT EXISTS display_sequence bigint,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

CREATE OR REPLACE FUNCTION private.set_notification_outbox_display_key()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, private, pg_temp
AS $$
BEGIN
  IF NEW.display_sequence IS NULL THEN
    NEW.display_sequence := nextval('private.family_notification_display_sequence');
  END IF;
  NEW.display_key := CASE
    WHEN NEW.event_type IN ('family_danger', 'family_alert_resolved') THEN
      NEW.family_id::text || ':' || coalesce(
        nullif(NEW.payload ->> 'triggered_by', ''),
        nullif(NEW.payload ->> 'resolved_by', ''),
        NEW.event_id::text
      )
    ELSE
      NEW.family_id::text || ':' || NEW.event_type || ':' || NEW.event_id::text
  END;
  NEW.payload := NEW.payload || jsonb_build_object(
    'display_key', NEW.display_key,
    'display_sequence', NEW.display_sequence
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.set_notification_outbox_display_key()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS set_notification_outbox_display_key
  ON private.notification_outbox;
CREATE TRIGGER set_notification_outbox_display_key
BEFORE INSERT OR UPDATE OF event_type, event_id, family_id, payload
ON private.notification_outbox
FOR EACH ROW
EXECUTE FUNCTION private.set_notification_outbox_display_key();

UPDATE private.notification_outbox AS job
SET display_sequence = nextval('private.family_notification_display_sequence')
WHERE job.display_sequence IS NULL;

UPDATE private.notification_outbox AS job
SET display_key = CASE
  WHEN job.event_type IN ('family_danger', 'family_alert_resolved') THEN
    job.family_id::text || ':' || coalesce(
      nullif(job.payload ->> 'triggered_by', ''),
      nullif(job.payload ->> 'resolved_by', ''),
      job.event_id::text
    )
  ELSE
    job.family_id::text || ':' || job.event_type || ':' || job.event_id::text
END
WHERE job.display_key IS NULL;

UPDATE private.notification_outbox AS job
SET payload = job.payload || jsonb_build_object(
  'display_key', job.display_key,
  'display_sequence', job.display_sequence
);

ALTER TABLE private.notification_outbox
  ALTER COLUMN display_key SET NOT NULL,
  ALTER COLUMN display_sequence
    SET DEFAULT nextval('private.family_notification_display_sequence'),
  ALTER COLUMN display_sequence SET NOT NULL;

CREATE INDEX IF NOT EXISTS notification_outbox_display_delivery_idx
  ON private.notification_outbox (
    recipient_user_id, display_key, status, next_attempt_at, created_at
  );

-- create_family_alert already terminalizes a superseded job. Preserve a
-- currently leased job until its worker completes so its replacement cannot
-- overtake it; terminalize any later retry instead.
CREATE OR REPLACE FUNCTION private.guard_superseded_notification_job()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, private, pg_temp
AS $$
BEGIN
  IF NEW.last_error IN (
    'Superseded by a newer family alert',
    'Family danger alert was resolved'
  ) THEN
    NEW.superseded_at := coalesce(NEW.superseded_at, statement_timestamp());
    IF OLD.status = 'processing' AND NEW.status = 'dead' THEN
      NEW.status := 'processing';
      NEW.locked_at := OLD.locked_at;
      NEW.lock_token := OLD.lock_token;
    END IF;
  END IF;

  IF coalesce(NEW.superseded_at, OLD.superseded_at) IS NOT NULL
     AND NEW.status IN ('pending', 'retry') THEN
    NEW.status := 'dead';
    NEW.locked_at := NULL;
    NEW.lock_token := NULL;
    NEW.last_error := coalesce(NEW.last_error, 'Superseded notification will not be retried');
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.guard_superseded_notification_job()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_superseded_notification_job
  ON private.notification_outbox;
CREATE TRIGGER guard_superseded_notification_job
BEFORE UPDATE OF status, last_error, superseded_at
ON private.notification_outbox
FOR EACH ROW
EXECUTE FUNCTION private.guard_superseded_notification_job();

CREATE OR REPLACE FUNCTION public.is_family_notification_job_current(
  p_job_id uuid,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, private, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM private.notification_outbox AS job
    WHERE job.id = p_job_id
      AND job.lock_token = p_lease_token
      AND job.status = 'processing'
      AND job.superseded_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION public.is_family_notification_job_current(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_family_notification_job_current(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_family_notification_deliveries(
  p_limit integer DEFAULT 25
)
RETURNS TABLE (
  job_id uuid,
  lease_token uuid,
  event_type text,
  event_id uuid,
  family_id uuid,
  recipient_user_id uuid,
  payload jsonb,
  device_tokens jsonb
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_claimed_ids uuid[];
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Dispatch batch size must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  -- A superseded worker gets a short grace period to finish its at-most
  -- ten-second provider request. If it vanished, terminate the stale lease.
  UPDATE private.notification_outbox AS job
  SET
    status = 'dead',
    locked_at = NULL,
    lock_token = NULL,
    last_error = 'Superseded notification lease expired',
    updated_at = statement_timestamp()
  WHERE job.status = 'processing'
    AND job.superseded_at IS NOT NULL
    AND job.locked_at < statement_timestamp() - interval '30 seconds';

  -- Recover normal recipient leases and their unfinished device attempts.
  WITH expired AS (
    UPDATE private.notification_outbox AS job
    SET
      status = 'retry',
      next_attempt_at = statement_timestamp(),
      locked_at = NULL,
      lock_token = NULL,
      last_error = 'Previous delivery lease expired',
      updated_at = statement_timestamp()
    WHERE job.status = 'processing'
      AND job.superseded_at IS NULL
      AND job.locked_at < statement_timestamp() - interval '5 minutes'
    RETURNING job.id
  )
  UPDATE private.notification_outbox_deliveries AS delivery
  SET
    status = 'retry',
    next_attempt_at = statement_timestamp(),
    last_error = 'Previous delivery lease expired',
    updated_at = statement_timestamp()
  FROM expired
  WHERE delivery.outbox_id = expired.id
    AND delivery.status = 'processing';

  WITH candidates AS (
    SELECT job.id
    FROM private.notification_outbox AS job
    WHERE job.status IN ('pending', 'retry')
      AND job.superseded_at IS NULL
      AND job.next_attempt_at <= statement_timestamp()
      AND NOT EXISTS (
        SELECT 1
        FROM private.notification_outbox AS active
        WHERE active.recipient_user_id = job.recipient_user_id
          AND active.display_key = job.display_key
          AND active.status = 'processing'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM private.notification_outbox AS older
        WHERE older.recipient_user_id = job.recipient_user_id
          AND older.display_key = job.display_key
          AND older.status IN ('pending', 'retry')
          AND older.superseded_at IS NULL
          AND older.next_attempt_at <= statement_timestamp()
          AND (
            older.next_attempt_at,
            older.created_at,
            older.id
          ) < (
            job.next_attempt_at,
            job.created_at,
            job.id
          )
      )
    ORDER BY job.next_attempt_at, job.created_at, job.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE private.notification_outbox AS job
    SET
      status = 'processing',
      attempts = job.attempts + 1,
      locked_at = statement_timestamp(),
      lock_token = gen_random_uuid(),
      updated_at = statement_timestamp()
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.id
  )
  SELECT coalesce(array_agg(claimed.id ORDER BY claimed.id), ARRAY[]::uuid[])
  INTO v_claimed_ids
  FROM claimed;

  IF cardinality(v_claimed_ids) = 0 THEN
    RETURN;
  END IF;

  INSERT INTO private.notification_outbox_deliveries (outbox_id, push_token_id)
  SELECT job.id, token.id
  FROM private.notification_outbox AS job
  JOIN private.device_push_tokens AS token
    ON token.user_id = job.recipient_user_id
   AND token.is_active
  WHERE job.id = ANY(v_claimed_ids)
    AND NOT EXISTS (
      SELECT 1
      FROM private.notification_outbox_deliveries AS existing
      WHERE existing.outbox_id = job.id
    )
  ON CONFLICT (outbox_id, push_token_id) DO NOTHING;

  UPDATE private.notification_outbox_deliveries AS delivery
  SET
    status = 'dead',
    last_error = 'Push token is no longer active',
    updated_at = statement_timestamp()
  WHERE delivery.outbox_id = ANY(v_claimed_ids)
    AND delivery.status IN ('pending', 'retry')
    AND NOT EXISTS (
      SELECT 1
      FROM private.device_push_tokens AS token
      WHERE token.id = delivery.push_token_id
        AND token.is_active
    );

  UPDATE private.notification_outbox_deliveries AS delivery
  SET
    status = 'processing',
    attempts = delivery.attempts + 1,
    updated_at = statement_timestamp()
  WHERE delivery.outbox_id = ANY(v_claimed_ids)
    AND delivery.status IN ('pending', 'retry')
    AND delivery.next_attempt_at <= statement_timestamp()
    AND EXISTS (
      SELECT 1
      FROM private.device_push_tokens AS token
      WHERE token.id = delivery.push_token_id
        AND token.is_active
    );

  RETURN QUERY
  SELECT
    job.id,
    job.lock_token,
    job.event_type,
    job.event_id,
    job.family_id,
    job.recipient_user_id,
    job.payload,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', token.id,
          'delivery_id', delivery.id,
          'token', token.token,
          'platform', token.platform
        ) ORDER BY token.last_seen_at DESC
      ) FILTER (WHERE token.id IS NOT NULL),
      '[]'::jsonb
    )
  FROM private.notification_outbox AS job
  LEFT JOIN private.notification_outbox_deliveries AS delivery
    ON delivery.outbox_id = job.id
   AND delivery.status = 'processing'
  LEFT JOIN private.device_push_tokens AS token
    ON token.id = delivery.push_token_id
   AND token.is_active
  WHERE job.id = ANY(v_claimed_ids)
  GROUP BY
    job.id,
    job.lock_token,
    job.event_type,
    job.event_id,
    job.family_id,
    job.recipient_user_id,
    job.payload;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_family_notification_deliveries(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_family_notification_deliveries(integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.raise_family_alert(
  p_family_id uuid,
  p_reason text,
  p_urgency text DEFAULT 'need_help',
  p_source text DEFAULT 'safety_status',
  p_client_event_id uuid DEFAULT gen_random_uuid(),
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_accuracy_m double precision DEFAULT NULL,
  p_heading_deg double precision DEFAULT NULL,
  p_speed_mps double precision DEFAULT NULL,
  p_recorded_at timestamptz DEFAULT NULL,
  p_address_label text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_alert_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_client_event_id IS NULL THEN
    RAISE EXCEPTION 'Client event is required' USING ERRCODE = '22023';
  END IF;

  -- All alert mutations lock in one order: membership, advisory key, alert.
  PERFORM 1
  FROM public.family_members AS member
  WHERE member.family_id = p_family_id
    AND member.user_id = v_user_id
    AND member.status = 'approved'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved family membership required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_family_id::text || ':' || v_user_id::text || ':alert', 0)
  );

  SELECT event.result_alert_id
  INTO v_alert_id
  FROM private.family_safety_client_events AS event
  WHERE event.family_id = p_family_id
    AND event.user_id = v_user_id
    AND event.client_event_id = p_client_event_id;
  IF FOUND THEN
    RETURN v_alert_id;
  END IF;

  v_alert_id := private.create_family_alert(
    p_family_id, v_user_id, p_source, p_urgency, p_reason, p_client_event_id,
    p_latitude, p_longitude, p_accuracy_m, p_heading_deg, p_speed_mps,
    p_recorded_at, p_address_label
  );

  UPDATE public.family_members AS member
  SET
    safety_status = 'in_danger',
    last_updated_safety = statement_timestamp(),
    first_name = public.canonical_user_first_name(v_user_id)
  WHERE member.family_id = p_family_id
    AND member.user_id = v_user_id
    AND member.status = 'approved';

  INSERT INTO private.family_safety_client_events (
    family_id, user_id, client_event_id, safety_status, result_alert_id
  )
  VALUES (p_family_id, v_user_id, p_client_event_id, 'in_danger', v_alert_id);

  RETURN v_alert_id;
END;
$$;

REVOKE ALL ON FUNCTION public.raise_family_alert(
  uuid, text, text, text, uuid,
  double precision, double precision, double precision, double precision,
  double precision, timestamptz, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raise_family_alert(
  uuid, text, text, text, uuid,
  double precision, double precision, double precision, double precision,
  double precision, timestamptz, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_my_family_safety_v2(
  p_family_id uuid,
  p_safety_status text,
  p_reason text DEFAULT NULL,
  p_urgency text DEFAULT NULL,
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_accuracy_m double precision DEFAULT NULL,
  p_heading_deg double precision DEFAULT NULL,
  p_speed_mps double precision DEFAULT NULL,
  p_recorded_at timestamptz DEFAULT NULL,
  p_address_label text DEFAULT NULL,
  p_client_event_id uuid DEFAULT gen_random_uuid(),
  p_source text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_first_name text;
  v_alert_id uuid;
  v_alert_source text;
  v_resolved_id uuid;
  v_resolution_payload jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_safety_status NOT IN ('safe', 'unknown', 'in_danger') THEN
    RAISE EXCEPTION 'Invalid safety status' USING ERRCODE = '22023';
  END IF;
  IF p_client_event_id IS NULL THEN
    RAISE EXCEPTION 'Client event is required' USING ERRCODE = '22023';
  END IF;

  SELECT member.first_name
  INTO v_first_name
  FROM public.family_members AS member
  WHERE member.family_id = p_family_id
    AND member.user_id = v_user_id
    AND member.status = 'approved'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved family membership not found' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_family_id::text || ':' || v_user_id::text || ':alert', 0)
  );

  -- Every status transition is idempotent. This prevents a delayed SAFE retry
  -- from clearing a newer danger occurrence.
  SELECT event.result_alert_id
  INTO v_alert_id
  FROM private.family_safety_client_events AS event
  WHERE event.family_id = p_family_id
    AND event.user_id = v_user_id
    AND event.client_event_id = p_client_event_id;
  IF FOUND THEN
    RETURN v_alert_id;
  END IF;

  UPDATE public.family_members AS member
  SET
    safety_status = p_safety_status,
    last_updated_safety = statement_timestamp(),
    first_name = public.canonical_user_first_name(v_user_id)
  WHERE member.family_id = p_family_id
    AND member.user_id = v_user_id
    AND member.status = 'approved'
  RETURNING member.first_name INTO v_first_name;

  IF p_safety_status = 'in_danger' THEN
    v_alert_source := coalesce(
      nullif(p_source, ''),
      CASE WHEN EXISTS (
        SELECT 1
        FROM public.family_driving_sessions AS driving
        WHERE driving.family_id = p_family_id
          AND driving.user_id = v_user_id
          AND driving.status = 'active'
      ) THEN 'driving' ELSE 'safety_status' END
    );
    v_alert_id := private.create_family_alert(
      p_family_id,
      v_user_id,
      v_alert_source,
      coalesce(nullif(p_urgency, ''), 'need_help'),
      p_reason,
      p_client_event_id,
      p_latitude,
      p_longitude,
      p_accuracy_m,
      p_heading_deg,
      p_speed_mps,
      p_recorded_at,
      p_address_label
    );
  ELSE
    UPDATE public.family_alerts AS alert
    SET
      status = 'resolved',
      resolved_at = statement_timestamp(),
      resolved_by = v_user_id,
      resolution_note = CASE
        WHEN p_safety_status = 'safe' THEN 'Marked safe by the person who raised the alert.'
        ELSE 'Danger status cleared by the person who raised the alert.'
      END,
      updated_at = statement_timestamp()
    WHERE alert.family_id = p_family_id
      AND alert.triggered_by = v_user_id
      AND alert.status = 'active'
    RETURNING alert.id INTO v_resolved_id;

    IF v_resolved_id IS NOT NULL THEN
      -- Pending danger sends die immediately. A currently leased send keeps its
      -- lease so the resolution cannot overtake it; the dispatcher checks its
      -- generation immediately before contacting FCM.
      UPDATE private.notification_outbox AS job
      SET
        status = 'dead',
        locked_at = NULL,
        lock_token = NULL,
        last_error = 'Family danger alert was resolved',
        updated_at = statement_timestamp()
      WHERE job.event_type = 'family_danger'
        AND job.event_id = v_resolved_id
        AND job.status IN ('pending', 'retry', 'processing');

      v_resolution_payload := jsonb_build_object(
        'version', 2,
        'type', 'family_alert_resolved',
        'alert_id', v_resolved_id,
        'family_id', p_family_id,
        'triggered_by', v_user_id,
        'resolved_by', v_user_id,
        'actor_name', v_first_name,
        'safety_status', p_safety_status,
        'resolved_at', statement_timestamp()
      );
      PERFORM private.enqueue_family_notifications(
        'family_alert_resolved', v_resolved_id, p_family_id, v_user_id,
        v_resolution_payload, true
      );
      BEGIN
        PERFORM private.broadcast_family_safety(
          p_family_id, 'family_alert_resolved', v_resolution_payload
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  END IF;

  INSERT INTO private.family_safety_client_events (
    family_id, user_id, client_event_id, safety_status, result_alert_id
  )
  VALUES (
    p_family_id, v_user_id, p_client_event_id, p_safety_status, v_alert_id
  );

  BEGIN
    PERFORM private.broadcast_family_safety(
      p_family_id,
      'safety_status_changed',
      jsonb_build_object(
        'version', 2,
        'type', 'safety_status_changed',
        'family_id', p_family_id,
        'user_id', v_user_id,
        'first_name', v_first_name,
        'safety_status', p_safety_status,
        'updated_at', statement_timestamp(),
        'alert_id', v_alert_id
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.family_messages (
      family_id, user_id, first_name, content, message_type
    )
    VALUES (
      p_family_id,
      v_user_id,
      v_first_name,
      'marked status as ' || upper(p_safety_status),
      'status_update'
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_alert_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_my_family_safety_v2(
  uuid, text, text, text,
  double precision, double precision, double precision, double precision,
  double precision, timestamptz, text, uuid, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_family_safety_v2(
  uuid, text, text, text,
  double precision, double precision, double precision, double precision,
  double precision, timestamptz, text, uuid, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.resolve_my_family_alert(
  p_alert_id uuid,
  p_resolution_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_family_id uuid;
  v_actor_name text;
  v_note text;
  v_payload jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_resolution_note IS NOT NULL
     AND char_length(btrim(p_resolution_note)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Resolution note must be between 1 and 500 characters'
      USING ERRCODE = '22023';
  END IF;

  -- Read only to discover the lock key; the authoritative active check happens
  -- after membership + advisory locks are held.
  SELECT alert.family_id
  INTO v_family_id
  FROM public.family_alerts AS alert
  WHERE alert.id = p_alert_id
    AND alert.triggered_by = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Family alert owned by this user was not found'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.family_members AS member
  WHERE member.family_id = v_family_id
    AND member.user_id = v_user_id
    AND member.status = 'approved'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved family membership not found' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_family_id::text || ':' || v_user_id::text || ':alert', 0)
  );

  v_note := coalesce(
    nullif(btrim(p_resolution_note), ''),
    'Marked safe by the person who raised the alert.'
  );
  UPDATE public.family_alerts AS alert
  SET
    status = 'resolved',
    resolved_at = statement_timestamp(),
    resolved_by = v_user_id,
    resolution_note = v_note,
    updated_at = statement_timestamp()
  WHERE alert.id = p_alert_id
    AND alert.triggered_by = v_user_id
    AND alert.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active alert owned by this user was not found'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.family_members AS member
  SET safety_status = 'safe', last_updated_safety = statement_timestamp()
  WHERE member.family_id = v_family_id
    AND member.user_id = v_user_id
    AND member.status = 'approved';

  UPDATE private.notification_outbox AS job
  SET
    status = 'dead',
    locked_at = NULL,
    lock_token = NULL,
    last_error = 'Family danger alert was resolved',
    updated_at = statement_timestamp()
  WHERE job.event_type = 'family_danger'
    AND job.event_id = p_alert_id
    AND job.status IN ('pending', 'retry', 'processing');

  v_actor_name := public.canonical_user_first_name(v_user_id);
  v_payload := jsonb_build_object(
    'version', 2,
    'type', 'family_alert_resolved',
    'alert_id', p_alert_id,
    'family_id', v_family_id,
    'triggered_by', v_user_id,
    'resolved_by', v_user_id,
    'actor_name', v_actor_name,
    'resolution_note', v_note,
    'resolved_at', statement_timestamp()
  );

  PERFORM private.enqueue_family_notifications(
    'family_alert_resolved', p_alert_id, v_family_id, v_user_id,
    v_payload, true
  );
  BEGIN
    PERFORM private.broadcast_family_safety(
      v_family_id, 'family_alert_resolved', v_payload
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_my_family_alert(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_my_family_alert(uuid, text)
  TO authenticated;

-- The legacy two-argument status RPC cannot carry a client event ID and is
-- therefore unsafe under delayed network retries. Current clients use v2.
REVOKE ALL ON FUNCTION public.set_my_family_safety(uuid, text)
  FROM PUBLIC, anon, authenticated;

COMMIT;
