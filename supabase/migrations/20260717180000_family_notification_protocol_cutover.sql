-- Cut family notifications over to a single ordered, data-only delivery
-- protocol. Retire ambiguous pre-protocol safety jobs, rebuild authoritative
-- active alerts with fresh sequences, and reject cross-status idempotency-key
-- reuse before it can mutate family safety state.

BEGIN;

LOCK TABLE public.family_members IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.family_alerts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE private.notification_outbox IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE private.notification_outbox_deliveries IN SHARE ROW EXCLUSIVE MODE;

-- A pre-protocol backfill could not infer the chronological relationship
-- between already-existing danger and resolution rows. None of those rows may
-- cross the v3 delivery boundary.
UPDATE private.notification_outbox AS job
SET
  status = 'dead',
  locked_at = NULL,
  lock_token = NULL,
  last_error = 'Retired during ordered notification protocol cutover',
  updated_at = statement_timestamp()
WHERE job.event_type IN ('family_danger', 'family_alert_resolved')
  AND job.status IN ('pending', 'retry', 'processing');

-- Active alerts are re-created below. Delete their prior recipient jobs so an
-- ON CONFLICT reset cannot retain an arbitrarily backfilled display sequence
-- or terminal per-device delivery rows.
DELETE FROM private.notification_outbox AS job
USING public.family_alerts AS alert
WHERE job.event_type = 'family_danger'
  AND job.event_id = alert.id
  AND alert.status = 'active'
  AND alert.resolved_at IS NULL;

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
    'notification_protocol_version', 3,
    'display_key', NEW.display_key,
    'display_sequence', NEW.display_sequence
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.set_notification_outbox_display_key()
  FROM PUBLIC, anon, authenticated;

-- Bring retained driving/history rows under the same invariant before adding
-- the validated table constraint.
UPDATE private.notification_outbox AS job
SET payload = job.payload || jsonb_build_object(
  'notification_protocol_version', 3,
  'display_key', job.display_key,
  'display_sequence', job.display_sequence
);

ALTER TABLE private.notification_outbox
  DROP CONSTRAINT IF EXISTS notification_outbox_display_protocol_check;
ALTER TABLE private.notification_outbox
  ADD CONSTRAINT notification_outbox_display_protocol_check CHECK (
    display_sequence > 0
    AND char_length(display_key) BETWEEN 1 AND 220
    AND payload ->> 'notification_protocol_version' = '3'
    AND payload ->> 'display_key' = display_key
    AND payload ->> 'display_sequence' = display_sequence::text
  ) NOT VALID;
ALTER TABLE private.notification_outbox
  VALIDATE CONSTRAINT notification_outbox_display_protocol_check;

-- Rebuild only the current emergency state. Resolved history remains in
-- family_alerts; replaying old resolution notifications during a protocol
-- cutover would create noise and could overwrite newer state on old clients.
DO $$
DECLARE
  v_alert public.family_alerts%ROWTYPE;
  v_payload jsonb;
BEGIN
  FOR v_alert IN
    SELECT alert.*
    FROM public.family_alerts AS alert
    WHERE alert.status = 'active'
      AND alert.resolved_at IS NULL
    ORDER BY alert.created_at, alert.id
  LOOP
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'version', 3,
      'type', 'family_danger',
      'alert_id', v_alert.id,
      'family_id', v_alert.family_id,
      'triggered_by', v_alert.triggered_by,
      'actor_name', public.canonical_user_first_name(v_alert.triggered_by),
      'source', v_alert.source,
      'urgency', v_alert.urgency,
      'reason', v_alert.reason,
      'latitude', v_alert.latitude,
      'longitude', v_alert.longitude,
      'accuracy_m', v_alert.accuracy_m,
      'heading_deg', v_alert.heading_deg,
      'speed_mps', v_alert.speed_mps,
      'location_recorded_at', v_alert.location_recorded_at,
      'address_label', v_alert.address_label,
      'created_at', v_alert.created_at,
      'updated_at', v_alert.updated_at
    ));

    PERFORM private.enqueue_family_notifications(
      'family_danger',
      v_alert.id,
      v_alert.family_id,
      v_alert.triggered_by,
      v_payload,
      false
    );
  END LOOP;
END;
$$;

-- This function name is the capability boundary for the data-only Android
-- dispatcher. Validation happens after the nested claim but in the same
-- transaction; raising rolls every lease mutation back atomically.
CREATE OR REPLACE FUNCTION public.claim_family_notification_deliveries_v3(
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
  v_job record;
BEGIN
  FOR v_job IN
    SELECT *
    FROM public.claim_family_notification_deliveries(p_limit)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM private.notification_outbox AS authoritative
      WHERE authoritative.id = v_job.job_id
        AND authoritative.status = 'processing'
        AND authoritative.lock_token = v_job.lease_token
        AND authoritative.display_sequence > 0
        AND char_length(authoritative.display_key) BETWEEN 1 AND 220
        AND authoritative.payload ->> 'notification_protocol_version' = '3'
        AND authoritative.payload ->> 'display_key' = authoritative.display_key
        AND authoritative.payload ->> 'display_sequence'
          = authoritative.display_sequence::text
    ) THEN
      RAISE EXCEPTION 'Notification claim failed the ordered-display protocol'
        USING ERRCODE = '55000';
    END IF;

    IF jsonb_typeof(v_job.device_tokens) IS DISTINCT FROM 'array'
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(v_job.device_tokens) AS device(value)
         WHERE jsonb_typeof(device.value) IS DISTINCT FROM 'object'
           OR nullif(device.value ->> 'id', '') IS NULL
           OR nullif(device.value ->> 'delivery_id', '') IS NULL
           OR nullif(device.value ->> 'token', '') IS NULL
           OR nullif(device.value ->> 'platform', '') IS NULL
       ) THEN
      RAISE EXCEPTION 'Notification claim contains invalid per-device delivery state'
        USING ERRCODE = '55000';
    END IF;

    job_id := v_job.job_id;
    lease_token := v_job.lease_token;
    event_type := v_job.event_type;
    event_id := v_job.event_id;
    family_id := v_job.family_id;
    recipient_user_id := v_job.recipient_user_id;
    payload := v_job.payload;
    device_tokens := v_job.device_tokens;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_family_notification_deliveries_v3(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_family_notification_deliveries_v3(integer)
  TO service_role;

-- Pause every pre-v3 worker path. The v3 SECURITY DEFINER function can still
-- call the underlying implementation as its owner.
REVOKE EXECUTE ON FUNCTION public.claim_family_notification_deliveries(integer)
  FROM service_role;
REVOKE EXECUTE ON FUNCTION public.claim_family_notification_outbox(integer)
  FROM service_role;

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
  v_recorded_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_client_event_id IS NULL THEN
    RAISE EXCEPTION 'Client event is required' USING ERRCODE = '22023';
  END IF;

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

  SELECT event.safety_status, event.result_alert_id
  INTO v_recorded_status, v_alert_id
  FROM private.family_safety_client_events AS event
  WHERE event.family_id = p_family_id
    AND event.user_id = v_user_id
    AND event.client_event_id = p_client_event_id;
  IF FOUND THEN
    IF v_recorded_status IS DISTINCT FROM 'in_danger' THEN
      RAISE EXCEPTION 'Client event ID was already used for a different safety status'
        USING ERRCODE = '22023';
    END IF;
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
  v_recorded_status text;
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

  SELECT event.safety_status, event.result_alert_id
  INTO v_recorded_status, v_alert_id
  FROM private.family_safety_client_events AS event
  WHERE event.family_id = p_family_id
    AND event.user_id = v_user_id
    AND event.client_event_id = p_client_event_id;
  IF FOUND THEN
    IF v_recorded_status IS DISTINCT FROM p_safety_status THEN
      RAISE EXCEPTION 'Client event ID was already used for a different safety status'
        USING ERRCODE = '22023';
    END IF;
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
        'version', 3,
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
        'version', 3,
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

REVOKE ALL ON FUNCTION public.set_my_family_safety(uuid, text)
  FROM PUBLIC, anon, authenticated;

COMMIT;
