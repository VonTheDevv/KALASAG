-- Family driving, exact-location sharing, and durable emergency delivery.
--
-- Public state is readable only by approved members of the same family and is
-- writable only through the authenticated RPCs below. Push tokens, tracking
-- idempotency records, and notification delivery jobs never enter an exposed
-- schema. Realtime is a low-latency hint; persisted rows remain authoritative.

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 1. Durable public family-safety state.
-- ---------------------------------------------------------------------------

CREATE TABLE public.family_driving_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  client_event_id uuid NOT NULL,
  tracking_token_hash bytea,
  tracking_token_expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ended_at timestamptz,
  last_location_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT family_driving_sessions_status_check
    CHECK (status IN ('active', 'ended')),
  CONSTRAINT family_driving_sessions_state_check CHECK (
    (status = 'active' AND ended_at IS NULL AND tracking_token_hash IS NOT NULL)
    OR
    (status = 'ended' AND ended_at IS NOT NULL AND tracking_token_hash IS NULL)
  ),
  CONSTRAINT family_driving_sessions_time_check
    CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT family_driving_sessions_client_event_unique
    UNIQUE (family_id, user_id, client_event_id)
);

CREATE UNIQUE INDEX family_driving_sessions_one_active_idx
  ON public.family_driving_sessions (family_id, user_id)
  WHERE status = 'active';
CREATE INDEX family_driving_sessions_family_status_updated_idx
  ON public.family_driving_sessions (family_id, status, updated_at DESC);
CREATE INDEX family_driving_sessions_user_status_idx
  ON public.family_driving_sessions (user_id, status, started_at DESC);
CREATE INDEX family_driving_sessions_expiry_idx
  ON public.family_driving_sessions (tracking_token_expires_at)
  WHERE status = 'active';

CREATE TABLE public.family_live_locations (
  session_id uuid PRIMARY KEY
    REFERENCES public.family_driving_sessions(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  accuracy_m double precision NOT NULL,
  heading_deg double precision,
  speed_mps double precision,
  address_label text,
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT family_live_locations_latitude_check
    CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT family_live_locations_longitude_check
    CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT family_live_locations_accuracy_check
    CHECK (accuracy_m BETWEEN 0 AND 100000),
  CONSTRAINT family_live_locations_heading_check
    CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)),
  CONSTRAINT family_live_locations_speed_check
    CHECK (speed_mps IS NULL OR speed_mps BETWEEN 0 AND 250),
  CONSTRAINT family_live_locations_address_check
    CHECK (address_label IS NULL OR char_length(address_label) BETWEEN 1 AND 500)
);

CREATE INDEX family_live_locations_family_recorded_idx
  ON public.family_live_locations (family_id, recorded_at DESC);
CREATE INDEX family_live_locations_user_recorded_idx
  ON public.family_live_locations (user_id, recorded_at DESC);

CREATE TABLE public.family_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  triggered_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source text NOT NULL,
  urgency text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  client_event_id uuid NOT NULL,
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  heading_deg double precision,
  speed_mps double precision,
  location_recorded_at timestamptz,
  address_label text,
  last_notified_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note text,
  CONSTRAINT family_alerts_source_check
    CHECK (source IN ('safety_status', 'driving')),
  CONSTRAINT family_alerts_urgency_check
    CHECK (urgency IN ('need_help', 'urgent_authorities')),
  CONSTRAINT family_alerts_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT family_alerts_status_check
    CHECK (status IN ('active', 'resolved')),
  CONSTRAINT family_alerts_state_check CHECK (
    (status = 'active' AND resolved_at IS NULL AND resolved_by IS NULL)
    OR
    (status = 'resolved' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
  ),
  CONSTRAINT family_alerts_position_check CHECK (
    (
      latitude IS NULL
      AND longitude IS NULL
      AND accuracy_m IS NULL
      AND heading_deg IS NULL
      AND speed_mps IS NULL
      AND location_recorded_at IS NULL
    ) OR (
      latitude BETWEEN -90 AND 90
      AND longitude BETWEEN -180 AND 180
      AND accuracy_m BETWEEN 0 AND 100000
      AND (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360))
      AND (speed_mps IS NULL OR speed_mps BETWEEN 0 AND 250)
      AND location_recorded_at IS NOT NULL
    )
  ),
  CONSTRAINT family_alerts_address_check
    CHECK (address_label IS NULL OR char_length(address_label) BETWEEN 1 AND 500),
  CONSTRAINT family_alerts_resolution_note_check
    CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 500),
  CONSTRAINT family_alerts_client_event_unique
    UNIQUE (family_id, triggered_by, client_event_id)
);

CREATE UNIQUE INDEX family_alerts_one_active_per_member_idx
  ON public.family_alerts (family_id, triggered_by)
  WHERE status = 'active';
CREATE INDEX family_alerts_family_status_created_idx
  ON public.family_alerts (family_id, status, created_at DESC);
CREATE INDEX family_alerts_actor_status_created_idx
  ON public.family_alerts (triggered_by, status, created_at DESC);

CREATE TABLE public.family_alert_acknowledgements (
  alert_id uuid NOT NULL REFERENCES public.family_alerts(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  acknowledged_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (alert_id, user_id)
);

CREATE INDEX family_alert_ack_family_user_idx
  ON public.family_alert_acknowledgements (family_id, user_id, acknowledged_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Private delivery and idempotency state. These tables are intentionally
-- unavailable to PostgREST clients; narrow RPCs are the only access path.
-- ---------------------------------------------------------------------------

CREATE TABLE private.family_alert_client_events (
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_event_id uuid NOT NULL,
  alert_id uuid NOT NULL REFERENCES public.family_alerts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (family_id, user_id, client_event_id)
);

CREATE INDEX family_alert_client_events_alert_idx
  ON private.family_alert_client_events (alert_id);

CREATE TABLE private.device_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  token text NOT NULL,
  token_hash bytea NOT NULL,
  platform text NOT NULL DEFAULT 'android',
  app_version text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT device_push_tokens_platform_check
    CHECK (platform IN ('android', 'ios', 'web')),
  CONSTRAINT device_push_tokens_token_length_check
    CHECK (char_length(token) BETWEEN 20 AND 4096),
  CONSTRAINT device_push_tokens_app_version_check
    CHECK (app_version IS NULL OR char_length(app_version) BETWEEN 1 AND 100),
  CONSTRAINT device_push_tokens_installation_unique UNIQUE (user_id, installation_id),
  CONSTRAINT device_push_tokens_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX device_push_tokens_user_active_idx
  ON private.device_push_tokens (user_id, last_seen_at DESC)
  WHERE is_active;

CREATE TABLE private.notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  event_id uuid NOT NULL,
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  locked_at timestamptz,
  lock_token uuid,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  sent_at timestamptz,
  CONSTRAINT notification_outbox_event_type_check CHECK (
    event_type IN ('driving_started', 'family_danger', 'family_alert_resolved')
  ),
  CONSTRAINT notification_outbox_status_check
    CHECK (status IN ('pending', 'processing', 'retry', 'sent', 'dead')),
  CONSTRAINT notification_outbox_attempts_check
    CHECK (attempts BETWEEN 0 AND 20),
  CONSTRAINT notification_outbox_payload_check CHECK (
    jsonb_typeof(payload) = 'object'
    AND octet_length(payload::text) <= 16384
  ),
  CONSTRAINT notification_outbox_event_recipient_unique
    UNIQUE (event_type, event_id, recipient_user_id)
);

CREATE INDEX notification_outbox_ready_idx
  ON private.notification_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'retry');
CREATE INDEX notification_outbox_processing_idx
  ON private.notification_outbox (locked_at)
  WHERE status = 'processing';
CREATE INDEX notification_outbox_recipient_created_idx
  ON private.notification_outbox (recipient_user_id, created_at DESC);

REVOKE ALL ON TABLE private.family_alert_client_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE private.device_push_tokens FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE private.notification_outbox FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. RLS and explicit Data API grants. The token hash is deliberately omitted
-- from the authenticated column grant even though it is a one-way digest.
-- ---------------------------------------------------------------------------

ALTER TABLE public.family_driving_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_live_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_alert_acknowledgements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Approved members can read family driving sessions"
  ON public.family_driving_sessions
  FOR SELECT TO authenticated
  USING (public.is_approved_family_member(family_id));

CREATE POLICY "Approved members can read family live locations"
  ON public.family_live_locations
  FOR SELECT TO authenticated
  USING (public.is_approved_family_member(family_id));

CREATE POLICY "Approved members can read family alerts"
  ON public.family_alerts
  FOR SELECT TO authenticated
  USING (public.is_approved_family_member(family_id));

CREATE POLICY "Approved members can read family alert acknowledgements"
  ON public.family_alert_acknowledgements
  FOR SELECT TO authenticated
  USING (public.is_approved_family_member(family_id));

REVOKE ALL ON TABLE public.family_driving_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.family_live_locations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.family_alerts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.family_alert_acknowledgements FROM PUBLIC, anon, authenticated;

GRANT SELECT (
  id, family_id, user_id, status, client_event_id,
  tracking_token_expires_at, started_at, ended_at, last_location_at,
  created_at, updated_at
) ON public.family_driving_sessions TO authenticated;
GRANT SELECT ON public.family_live_locations TO authenticated;
GRANT SELECT ON public.family_alerts TO authenticated;
GRANT SELECT ON public.family_alert_acknowledgements TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Private helpers: validation, server-originated private broadcasts, and
-- transactional notification fan-out.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.validate_family_position(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision,
  p_heading_deg double precision,
  p_speed_mps double precision,
  p_recorded_at timestamptz,
  p_address_label text
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_latitude IS NULL AND p_longitude IS NULL THEN
    IF p_accuracy_m IS NOT NULL OR p_heading_deg IS NOT NULL
       OR p_speed_mps IS NOT NULL OR p_recorded_at IS NOT NULL THEN
      RAISE EXCEPTION 'Incomplete location payload' USING ERRCODE = '22023';
    END IF;
  ELSIF p_latitude IS NULL OR p_longitude IS NULL
     OR p_accuracy_m IS NULL OR p_recorded_at IS NULL THEN
    RAISE EXCEPTION 'Latitude, longitude, accuracy, and observation time are required together'
      USING ERRCODE = '22023';
  ELSIF p_latitude NOT BETWEEN -90 AND 90
     OR p_longitude NOT BETWEEN -180 AND 180
     OR p_accuracy_m NOT BETWEEN 0 AND 100000
     OR (p_heading_deg IS NOT NULL AND NOT (p_heading_deg >= 0 AND p_heading_deg < 360))
     OR (p_speed_mps IS NOT NULL AND p_speed_mps NOT BETWEEN 0 AND 250) THEN
    RAISE EXCEPTION 'Invalid location payload' USING ERRCODE = '22023';
  END IF;

  IF p_address_label IS NOT NULL
     AND char_length(btrim(p_address_label)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Address label must be between 1 and 500 characters'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.validate_family_position(
  double precision, double precision, double precision, double precision,
  double precision, timestamptz, text
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.broadcast_family_safety(
  p_family_id uuid,
  p_event text,
  p_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, realtime, pg_temp
AS $$
BEGIN
  IF p_family_id IS NULL OR p_event IS NULL OR p_payload IS NULL THEN
    RETURN;
  END IF;

  -- Keep migrations usable against older local Realtime versions. Persisted
  -- state and FCM outbox delivery continue to work if realtime.send is absent.
  IF to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'SELECT realtime.send($1, $2, $3, true)'
    USING p_payload, left(p_event, 100), 'family:' || p_family_id::text || ':safety';
END;
$$;

REVOKE ALL ON FUNCTION private.broadcast_family_safety(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.enqueue_family_notifications(
  p_event_type text,
  p_event_id uuid,
  p_family_id uuid,
  p_actor_id uuid,
  p_payload jsonb,
  p_reset_existing boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO private.notification_outbox AS outbox (
    event_type, event_id, family_id, recipient_user_id, payload
  )
  SELECT
    p_event_type,
    p_event_id,
    p_family_id,
    recipient.user_id,
    p_payload
  FROM (
    SELECT member.user_id
    FROM public.family_members AS member
    WHERE member.family_id = p_family_id
      AND member.status = 'approved'
    UNION
    SELECT family.host_id
    FROM public.families AS family
    WHERE family.id = p_family_id
  ) AS recipient
  WHERE recipient.user_id <> p_actor_id
  ON CONFLICT (event_type, event_id, recipient_user_id) DO UPDATE
  SET
    payload = EXCLUDED.payload,
    status = CASE
      WHEN p_reset_existing THEN 'pending'
      ELSE outbox.status
    END,
    attempts = CASE WHEN p_reset_existing THEN 0 ELSE outbox.attempts END,
    next_attempt_at = CASE
      WHEN p_reset_existing THEN statement_timestamp()
      ELSE outbox.next_attempt_at
    END,
    locked_at = CASE WHEN p_reset_existing THEN NULL ELSE outbox.locked_at END,
    lock_token = CASE WHEN p_reset_existing THEN NULL ELSE outbox.lock_token END,
    last_error = CASE WHEN p_reset_existing THEN NULL ELSE outbox.last_error END,
    updated_at = statement_timestamp();

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION private.enqueue_family_notifications(
  text, uuid, uuid, uuid, jsonb, boolean
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.create_family_alert(
  p_family_id uuid,
  p_user_id uuid,
  p_source text,
  p_urgency text,
  p_reason text,
  p_client_event_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision,
  p_heading_deg double precision,
  p_speed_mps double precision,
  p_recorded_at timestamptz,
  p_address_label text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_alert public.family_alerts%ROWTYPE;
  v_alert_id uuid;
  v_actor_name text;
  v_urgency text;
  v_payload jsonb;
  v_should_renotify boolean := false;
BEGIN
  IF p_family_id IS NULL OR p_user_id IS NULL OR p_client_event_id IS NULL THEN
    RAISE EXCEPTION 'Family, user, and client event are required' USING ERRCODE = '22023';
  END IF;
  IF p_source NOT IN ('safety_status', 'driving') THEN
    RAISE EXCEPTION 'Invalid alert source' USING ERRCODE = '22023';
  END IF;
  -- The UI originally shipped `help`; keep the stored/event contract canonical
  -- without rejecting an emergency from that client version.
  v_urgency := CASE WHEN p_urgency = 'help' THEN 'need_help' ELSE p_urgency END;
  IF v_urgency NOT IN ('need_help', 'urgent_authorities') THEN
    RAISE EXCEPTION 'Invalid alert urgency' USING ERRCODE = '22023';
  END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'A danger reason between 1 and 500 characters is required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM private.validate_family_position(
    p_latitude, p_longitude, p_accuracy_m, p_heading_deg, p_speed_mps,
    p_recorded_at, p_address_label
  );
  IF p_recorded_at IS NOT NULL
     AND (p_recorded_at < statement_timestamp() - interval '1 hour'
          OR p_recorded_at > statement_timestamp() + interval '2 minutes') THEN
    RAISE EXCEPTION 'Alert location timestamp is outside the accepted window'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_family_id::text || ':' || p_user_id::text || ':alert', 0)
  );

  SELECT alert.*
  INTO v_alert
  FROM private.family_alert_client_events AS event
  JOIN public.family_alerts AS alert ON alert.id = event.alert_id
  WHERE event.family_id = p_family_id
    AND event.user_id = p_user_id
    AND event.client_event_id = p_client_event_id;

  IF FOUND THEN
    RETURN v_alert.id;
  END IF;

  SELECT alert.*
  INTO v_alert
  FROM public.family_alerts AS alert
  WHERE alert.family_id = p_family_id
    AND alert.triggered_by = p_user_id
    AND alert.status = 'active'
  FOR UPDATE;

  IF FOUND THEN
    v_should_renotify := v_alert.last_notified_at
      <= statement_timestamp() - interval '30 seconds';

    UPDATE public.family_alerts AS alert
    SET
      source = p_source,
      urgency = v_urgency,
      reason = btrim(p_reason),
      latitude = coalesce(p_latitude, alert.latitude),
      longitude = coalesce(p_longitude, alert.longitude),
      accuracy_m = coalesce(p_accuracy_m, alert.accuracy_m),
      heading_deg = CASE WHEN p_latitude IS NULL THEN alert.heading_deg ELSE p_heading_deg END,
      speed_mps = CASE WHEN p_latitude IS NULL THEN alert.speed_mps ELSE p_speed_mps END,
      location_recorded_at = coalesce(p_recorded_at, alert.location_recorded_at),
      address_label = CASE
        WHEN p_latitude IS NULL
          THEN coalesce(nullif(btrim(p_address_label), ''), alert.address_label)
        ELSE nullif(btrim(p_address_label), '')
      END,
      last_notified_at = CASE
        WHEN v_should_renotify THEN statement_timestamp()
        ELSE alert.last_notified_at
      END,
      updated_at = statement_timestamp()
    WHERE alert.id = v_alert.id
    RETURNING alert.* INTO v_alert;

    v_alert_id := v_alert.id;
  ELSE
    INSERT INTO public.family_alerts (
      family_id, triggered_by, source, urgency, reason, client_event_id,
      latitude, longitude, accuracy_m, heading_deg, speed_mps,
      location_recorded_at, address_label
    )
    VALUES (
      p_family_id, p_user_id, p_source, v_urgency, btrim(p_reason), p_client_event_id,
      p_latitude, p_longitude, p_accuracy_m, p_heading_deg, p_speed_mps,
      p_recorded_at, nullif(btrim(p_address_label), '')
    )
    RETURNING * INTO v_alert;

    v_alert_id := v_alert.id;
    v_should_renotify := true;
  END IF;

  INSERT INTO private.family_alert_client_events (
    family_id, user_id, client_event_id, alert_id
  )
  VALUES (p_family_id, p_user_id, p_client_event_id, v_alert_id)
  ON CONFLICT (family_id, user_id, client_event_id) DO NOTHING;

  v_actor_name := public.canonical_user_first_name(p_user_id);
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'version', 1,
    'type', 'family_danger',
    'alert_id', v_alert.id,
    'family_id', v_alert.family_id,
    'triggered_by', v_alert.triggered_by,
    'actor_name', v_actor_name,
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

  IF v_should_renotify THEN
    PERFORM private.enqueue_family_notifications(
      'family_danger', v_alert_id, p_family_id, p_user_id, v_payload,
      v_alert.created_at <> v_alert.updated_at
    );
  END IF;

  BEGIN
    PERFORM private.broadcast_family_safety(p_family_id, 'family_danger', v_payload);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_alert_id;
END;
$$;

REVOKE ALL ON FUNCTION private.create_family_alert(
  uuid, uuid, text, text, text, uuid,
  double precision, double precision, double precision, double precision,
  double precision, timestamptz, text
) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Authenticated family driving RPCs.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.start_family_driving(
  p_family_id uuid,
  p_client_event_id uuid DEFAULT gen_random_uuid()
)
RETURNS TABLE (
  session_id uuid,
  tracking_token text,
  tracking_expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public, private, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session public.family_driving_sessions%ROWTYPE;
  v_tracking_token text;
  v_actor_name text;
  v_recent_starts integer;
  v_payload jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_family_id IS NULL OR p_client_event_id IS NULL THEN
    RAISE EXCEPTION 'Family and client event are required' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_approved_family_member(p_family_id) THEN
    RAISE EXCEPTION 'Approved family membership required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_family_id::text || ':' || v_user_id::text || ':driving', 0)
  );

  SELECT driving.*
  INTO v_session
  FROM public.family_driving_sessions AS driving
  WHERE driving.family_id = p_family_id
    AND driving.user_id = v_user_id
    AND driving.client_event_id = p_client_event_id
  FOR UPDATE;

  IF FOUND AND v_session.status <> 'active' THEN
    RAISE EXCEPTION 'This driving start event has already ended'
      USING ERRCODE = '22023';
  END IF;

  IF NOT FOUND THEN
    SELECT driving.*
    INTO v_session
    FROM public.family_driving_sessions AS driving
    WHERE driving.family_id = p_family_id
      AND driving.user_id = v_user_id
      AND driving.status = 'active'
    FOR UPDATE;
  END IF;

  v_tracking_token := encode(extensions.gen_random_bytes(32), 'hex');

  IF FOUND THEN
    UPDATE public.family_driving_sessions AS driving
    SET
      tracking_token_hash = extensions.digest(v_tracking_token, 'sha256'),
      tracking_token_expires_at = statement_timestamp() + interval '18 hours',
      updated_at = statement_timestamp()
    WHERE driving.id = v_session.id;

    RETURN QUERY SELECT v_session.id, v_tracking_token, statement_timestamp() + interval '18 hours';
    RETURN;
  END IF;

  SELECT count(*)
  INTO v_recent_starts
  FROM public.family_driving_sessions AS driving
  WHERE driving.family_id = p_family_id
    AND driving.user_id = v_user_id
    AND driving.started_at >= statement_timestamp() - interval '10 minutes';

  IF v_recent_starts >= 6 THEN
    RAISE EXCEPTION 'Driving mode was started too frequently. Try again shortly.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.family_driving_sessions (
    family_id, user_id, client_event_id, tracking_token_hash,
    tracking_token_expires_at
  )
  VALUES (
    p_family_id, v_user_id, p_client_event_id,
    extensions.digest(v_tracking_token, 'sha256'),
    statement_timestamp() + interval '18 hours'
  )
  RETURNING * INTO v_session;

  v_actor_name := public.canonical_user_first_name(v_user_id);
  v_payload := jsonb_build_object(
    'version', 1,
    'type', 'driving_started',
    'session_id', v_session.id,
    'family_id', p_family_id,
    'user_id', v_user_id,
    'actor_name', v_actor_name,
    'started_at', v_session.started_at
  );

  PERFORM private.enqueue_family_notifications(
    'driving_started', v_session.id, p_family_id, v_user_id, v_payload, false
  );
  BEGIN
    PERFORM private.broadcast_family_safety(p_family_id, 'driving_started', v_payload);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY SELECT v_session.id, v_tracking_token, v_session.tracking_token_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.start_family_driving(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_family_driving(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_family_driving_location_with_token(
  p_session_id uuid,
  p_tracking_token text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision,
  p_heading_deg double precision,
  p_speed_mps double precision,
  p_recorded_at timestamptz,
  p_address_label text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public, private, pg_temp
AS $$
DECLARE
  v_authenticated_user_id uuid := auth.uid();
  v_user_id uuid;
  v_session public.family_driving_sessions%ROWTYPE;
  v_current public.family_live_locations%ROWTYPE;
  v_payload jsonb;
BEGIN
  IF p_session_id IS NULL OR p_tracking_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid tracking capability' USING ERRCODE = '42501';
  END IF;

  PERFORM private.validate_family_position(
    p_latitude, p_longitude, p_accuracy_m, p_heading_deg, p_speed_mps,
    p_recorded_at, p_address_label
  );
  IF p_latitude IS NULL THEN
    RAISE EXCEPTION 'A current location is required' USING ERRCODE = '22023';
  END IF;
  IF p_recorded_at < statement_timestamp() - interval '15 minutes'
     OR p_recorded_at > statement_timestamp() + interval '2 minutes' THEN
    RAISE EXCEPTION 'Location timestamp is outside the accepted window'
      USING ERRCODE = '22023';
  END IF;

  SELECT driving.*
  INTO v_session
  FROM public.family_driving_sessions AS driving
  WHERE driving.id = p_session_id
    AND driving.status = 'active'
    AND driving.tracking_token_expires_at > statement_timestamp()
    AND driving.tracking_token_hash = extensions.digest(p_tracking_token, 'sha256')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Driving session or tracking capability is invalid or expired'
      USING ERRCODE = '42501';
  END IF;
  v_user_id := v_session.user_id;

  -- A foreground service may outlive its short-lived user access token. The
  -- random 256-bit capability is therefore sufficient for this one narrowly
  -- scoped write. If a user JWT is present, it must still belong to the driver.
  IF v_authenticated_user_id IS NOT NULL
     AND v_authenticated_user_id <> v_user_id THEN
    RAISE EXCEPTION 'Tracking capability does not belong to this account'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.families AS family
    WHERE family.id = v_session.family_id
      AND family.host_id = v_user_id
    UNION ALL
    SELECT 1
    FROM public.family_members AS member
    WHERE member.family_id = v_session.family_id
      AND member.user_id = v_user_id
      AND member.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'Approved family membership required' USING ERRCODE = '42501';
  END IF;

  SELECT location.*
  INTO v_current
  FROM public.family_live_locations AS location
  WHERE location.session_id = p_session_id
  FOR UPDATE;

  IF FOUND AND p_recorded_at <= v_current.recorded_at THEN
    RETURN false;
  END IF;
  IF FOUND AND v_current.received_at > statement_timestamp() - interval '2 seconds' THEN
    RETURN false;
  END IF;

  INSERT INTO public.family_live_locations AS location (
    session_id, family_id, user_id, latitude, longitude, accuracy_m,
    heading_deg, speed_mps, address_label, recorded_at
  )
  VALUES (
    p_session_id, v_session.family_id, v_user_id, p_latitude, p_longitude,
    p_accuracy_m, p_heading_deg, p_speed_mps, nullif(btrim(p_address_label), ''),
    p_recorded_at
  )
  ON CONFLICT (session_id) DO UPDATE
  SET
    latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude,
    accuracy_m = EXCLUDED.accuracy_m,
    heading_deg = EXCLUDED.heading_deg,
    speed_mps = EXCLUDED.speed_mps,
    address_label = coalesce(EXCLUDED.address_label, location.address_label),
    recorded_at = EXCLUDED.recorded_at,
    received_at = statement_timestamp(),
    updated_at = statement_timestamp();

  UPDATE public.family_driving_sessions AS driving
  SET last_location_at = p_recorded_at, updated_at = statement_timestamp()
  WHERE driving.id = p_session_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'version', 1,
    'type', 'driving_location',
    'session_id', p_session_id,
    'family_id', v_session.family_id,
    'user_id', v_user_id,
    'latitude', p_latitude,
    'longitude', p_longitude,
    'accuracy_m', p_accuracy_m,
    'heading_deg', p_heading_deg,
    'speed_mps', p_speed_mps,
    'recorded_at', p_recorded_at,
    'address_label', nullif(btrim(p_address_label), '')
  ));
  BEGIN
    PERFORM private.broadcast_family_safety(
      v_session.family_id, 'driving_location', v_payload
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.update_family_driving_location_with_token(
  uuid, text, double precision, double precision, double precision,
  double precision, double precision, timestamptz, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_family_driving_location_with_token(
  uuid, text, double precision, double precision, double precision,
  double precision, double precision, timestamptz, text
) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.stop_family_driving(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_family_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  UPDATE public.family_driving_sessions AS driving
  SET
    status = 'ended',
    ended_at = statement_timestamp(),
    tracking_token_hash = NULL,
    tracking_token_expires_at = statement_timestamp(),
    updated_at = statement_timestamp()
  WHERE driving.id = p_session_id
    AND driving.user_id = v_user_id
    AND driving.status = 'active'
  RETURNING driving.family_id INTO v_family_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active driving session not found' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.family_live_locations AS location
  WHERE location.session_id = p_session_id;

  BEGIN
    PERFORM private.broadcast_family_safety(
      v_family_id,
      'driving_stopped',
      jsonb_build_object(
        'version', 1,
        'type', 'driving_stopped',
        'session_id', p_session_id,
        'family_id', v_family_id,
        'user_id', v_user_id,
        'ended_at', statement_timestamp()
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.stop_family_driving(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stop_family_driving(uuid) TO authenticated;

-- The persistent Android foreground-service notification can be acted on
-- after the short-lived user JWT has expired. This capability endpoint can do
-- exactly one thing: end the session identified by the matching 256-bit token.
CREATE OR REPLACE FUNCTION public.stop_family_driving_with_token(
  p_session_id uuid,
  p_tracking_token text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public, private, pg_temp
AS $$
DECLARE
  v_authenticated_user_id uuid := auth.uid();
  v_session public.family_driving_sessions%ROWTYPE;
BEGIN
  IF p_session_id IS NULL OR p_tracking_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid tracking capability' USING ERRCODE = '42501';
  END IF;

  SELECT driving.*
  INTO v_session
  FROM public.family_driving_sessions AS driving
  WHERE driving.id = p_session_id
    AND driving.status = 'active'
    AND driving.tracking_token_expires_at > statement_timestamp()
    AND driving.tracking_token_hash = extensions.digest(p_tracking_token, 'sha256')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Driving session or tracking capability is invalid or expired'
      USING ERRCODE = '42501';
  END IF;
  IF v_authenticated_user_id IS NOT NULL
     AND v_authenticated_user_id <> v_session.user_id THEN
    RAISE EXCEPTION 'Tracking capability does not belong to this account'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.families AS family
    WHERE family.id = v_session.family_id
      AND family.host_id = v_session.user_id
    UNION ALL
    SELECT 1
    FROM public.family_members AS member
    WHERE member.family_id = v_session.family_id
      AND member.user_id = v_session.user_id
      AND member.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'Approved family membership required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.family_driving_sessions AS driving
  SET
    status = 'ended',
    ended_at = statement_timestamp(),
    tracking_token_hash = NULL,
    tracking_token_expires_at = statement_timestamp(),
    updated_at = statement_timestamp()
  WHERE driving.id = p_session_id;

  DELETE FROM public.family_live_locations AS location
  WHERE location.session_id = p_session_id;

  BEGIN
    PERFORM private.broadcast_family_safety(
      v_session.family_id,
      'driving_stopped',
      jsonb_build_object(
        'version', 1,
        'type', 'driving_stopped',
        'session_id', p_session_id,
        'family_id', v_session.family_id,
        'user_id', v_session.user_id,
        'ended_at', statement_timestamp()
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.stop_family_driving_with_token(uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.stop_family_driving_with_token(uuid, text)
  TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Safety, danger, acknowledgement, and resolution RPCs.
-- ---------------------------------------------------------------------------

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
  IF NOT public.is_approved_family_member(p_family_id) THEN
    RAISE EXCEPTION 'Approved family membership required' USING ERRCODE = '42501';
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

  UPDATE public.family_members AS member
  SET
    safety_status = p_safety_status,
    last_updated_safety = statement_timestamp(),
    first_name = public.canonical_user_first_name(v_user_id)
  WHERE member.family_id = p_family_id
    AND member.user_id = v_user_id
    AND member.status = 'approved'
  RETURNING member.first_name INTO v_first_name;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved family membership not found' USING ERRCODE = '42501';
  END IF;

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
      v_resolution_payload := jsonb_build_object(
        'version', 1,
        'type', 'family_alert_resolved',
        'alert_id', v_resolved_id,
        'family_id', p_family_id,
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

  BEGIN
    PERFORM private.broadcast_family_safety(
      p_family_id,
      'safety_status_changed',
      jsonb_build_object(
        'version', 1,
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

  -- Preserve chat history for clients that have not yet migrated to the new
  -- event stream. Failure here never rolls back safety state or an alert.
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

-- Keep safe/unknown updates compatible for older clients, but do not let an
-- older client bypass the required, user-entered danger reason.
CREATE OR REPLACE FUNCTION public.set_my_family_safety(
  p_family_id uuid,
  p_safety_status text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
BEGIN
  IF p_safety_status = 'in_danger' THEN
    RAISE EXCEPTION 'A danger reason is required. Update KALASAG and try again.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.set_my_family_safety_v2(
    p_family_id,
    p_safety_status,
    NULL,
    NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_my_family_safety(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_family_safety(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.acknowledge_family_alert(p_alert_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_family_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT alert.family_id INTO v_family_id
  FROM public.family_alerts AS alert
  WHERE alert.id = p_alert_id;

  IF v_family_id IS NULL OR NOT public.is_approved_family_member(v_family_id) THEN
    RAISE EXCEPTION 'Family alert not found' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.family_alert_acknowledgements (
    alert_id, family_id, user_id
  )
  VALUES (p_alert_id, v_family_id, v_user_id)
  ON CONFLICT (alert_id, user_id) DO UPDATE
  SET acknowledged_at = statement_timestamp();

  BEGIN
    PERFORM private.broadcast_family_safety(
      v_family_id,
      'family_alert_acknowledged',
      jsonb_build_object(
        'version', 1,
        'type', 'family_alert_acknowledged',
        'alert_id', p_alert_id,
        'family_id', v_family_id,
        'user_id', v_user_id,
        'acknowledged_at', statement_timestamp()
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_family_alert(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_family_alert(uuid) TO authenticated;

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

  v_note := coalesce(nullif(btrim(p_resolution_note), ''), 'Marked safe by the person who raised the alert.');
  UPDATE public.family_alerts AS alert
  SET
    status = 'resolved',
    resolved_at = statement_timestamp(),
    resolved_by = v_user_id,
    resolution_note = v_note,
    updated_at = statement_timestamp()
  WHERE alert.id = p_alert_id
    AND alert.triggered_by = v_user_id
    AND alert.status = 'active'
  RETURNING alert.family_id INTO v_family_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active alert owned by this user was not found'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.family_members AS member
  SET safety_status = 'safe', last_updated_safety = statement_timestamp()
  WHERE member.family_id = v_family_id
    AND member.user_id = v_user_id
    AND member.status = 'approved';

  v_actor_name := public.canonical_user_first_name(v_user_id);
  v_payload := jsonb_build_object(
    'version', 1,
    'type', 'family_alert_resolved',
    'alert_id', p_alert_id,
    'family_id', v_family_id,
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

REVOKE ALL ON FUNCTION public.resolve_my_family_alert(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_my_family_alert(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Push registration plus service-role-only outbox leasing/completion.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.register_family_push_token(
  p_installation_id uuid,
  p_token text,
  p_platform text DEFAULT 'android',
  p_app_version text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public, private, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_token text := btrim(coalesce(p_token, ''));
  v_token_hash bytea;
  v_id uuid;
  v_active_count integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_installation_id IS NULL OR char_length(v_token) NOT BETWEEN 20 AND 4096
     OR v_token ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'Invalid push token' USING ERRCODE = '22023';
  END IF;
  IF p_platform NOT IN ('android', 'ios', 'web') THEN
    RAISE EXCEPTION 'Invalid push platform' USING ERRCODE = '22023';
  END IF;
  IF p_app_version IS NOT NULL
     AND char_length(btrim(p_app_version)) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid app version' USING ERRCODE = '22023';
  END IF;

  v_token_hash := extensions.digest(v_token, 'sha256');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':push', 0));

  -- A Firebase registration token represents one current app installation and
  -- must never remain assigned to a previous signed-in account.
  DELETE FROM private.device_push_tokens AS token
  WHERE token.token_hash = v_token_hash
    AND (token.user_id <> v_user_id OR token.installation_id <> p_installation_id);

  INSERT INTO private.device_push_tokens (
    user_id, installation_id, token, token_hash, platform, app_version
  )
  VALUES (
    v_user_id, p_installation_id, v_token, v_token_hash, p_platform,
    nullif(btrim(p_app_version), '')
  )
  ON CONFLICT (user_id, installation_id) DO UPDATE
  SET
    token = EXCLUDED.token,
    token_hash = EXCLUDED.token_hash,
    platform = EXCLUDED.platform,
    app_version = EXCLUDED.app_version,
    is_active = true,
    last_seen_at = statement_timestamp(),
    updated_at = statement_timestamp()
  RETURNING id INTO v_id;

  SELECT count(*) INTO v_active_count
  FROM private.device_push_tokens AS token
  WHERE token.user_id = v_user_id AND token.is_active;

  IF v_active_count > 10 THEN
    UPDATE private.device_push_tokens AS token
    SET is_active = false, updated_at = statement_timestamp()
    WHERE token.id IN (
      SELECT old_token.id
      FROM private.device_push_tokens AS old_token
      WHERE old_token.user_id = v_user_id
        AND old_token.is_active
        AND old_token.id <> v_id
      ORDER BY old_token.last_seen_at ASC
      LIMIT (v_active_count - 10)
    );
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.register_family_push_token(uuid, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_family_push_token(uuid, text, text, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.unregister_family_push_token(p_installation_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  UPDATE private.device_push_tokens AS token
  SET is_active = false, updated_at = statement_timestamp()
  WHERE token.user_id = v_user_id
    AND token.installation_id = p_installation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.unregister_family_push_token(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unregister_family_push_token(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_family_notification_outbox(
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
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Dispatch batch size must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  -- Recover leases abandoned by a crashed/terminated worker.
  UPDATE private.notification_outbox AS job
  SET
    status = 'retry',
    next_attempt_at = statement_timestamp(),
    locked_at = NULL,
    lock_token = NULL,
    last_error = 'Previous delivery lease expired',
    updated_at = statement_timestamp()
  WHERE job.status = 'processing'
    AND job.locked_at < statement_timestamp() - interval '5 minutes';

  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
    FROM private.notification_outbox AS job
    WHERE job.status IN ('pending', 'retry')
      AND job.next_attempt_at <= statement_timestamp()
    ORDER BY job.next_attempt_at, job.created_at
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
    RETURNING job.*
  )
  SELECT
    claimed.id,
    claimed.lock_token,
    claimed.event_type,
    claimed.event_id,
    claimed.family_id,
    claimed.recipient_user_id,
    claimed.payload,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', token.id,
        'token', token.token,
        'platform', token.platform
      ) ORDER BY token.last_seen_at DESC)
      FROM private.device_push_tokens AS token
      WHERE token.user_id = claimed.recipient_user_id
        AND token.is_active
    ), '[]'::jsonb)
  FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_family_notification_outbox(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_family_notification_outbox(integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.complete_family_notification_outbox(
  p_job_id uuid,
  p_lease_token uuid,
  p_success boolean,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_permanent boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_attempts integer;
BEGIN
  SELECT job.attempts INTO v_attempts
  FROM private.notification_outbox AS job
  WHERE job.id = p_job_id
    AND job.status = 'processing'
    AND job.lock_token = p_lease_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Notification delivery lease is invalid or expired'
      USING ERRCODE = '42501';
  END IF;

  UPDATE private.notification_outbox AS job
  SET
    status = CASE
      WHEN p_success THEN 'sent'
      WHEN p_permanent OR v_attempts >= 8 THEN 'dead'
      ELSE 'retry'
    END,
    next_attempt_at = CASE
      WHEN p_success OR p_permanent OR v_attempts >= 8 THEN job.next_attempt_at
      ELSE statement_timestamp() + make_interval(
        secs => least(3600, (30 * power(2, greatest(0, v_attempts - 1)))::integer)
      )
    END,
    provider_message_id = CASE
      WHEN p_success THEN left(p_provider_message_id, 500)
      ELSE job.provider_message_id
    END,
    last_error = CASE WHEN p_success THEN NULL ELSE left(coalesce(p_error, 'Delivery failed'), 1000) END,
    sent_at = CASE WHEN p_success THEN statement_timestamp() ELSE NULL END,
    locked_at = NULL,
    lock_token = NULL,
    updated_at = statement_timestamp()
  WHERE job.id = p_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_family_notification_outbox(
  uuid, uuid, boolean, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_family_notification_outbox(
  uuid, uuid, boolean, text, text, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.disable_family_push_token(p_token_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, private, pg_temp
AS $$
  UPDATE private.device_push_tokens AS token
  SET is_active = false, updated_at = statement_timestamp()
  WHERE token.id = p_token_id;
$$;

REVOKE ALL ON FUNCTION public.disable_family_push_token(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.disable_family_push_token(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. Private Realtime topic authorization and retention.
-- ---------------------------------------------------------------------------

DO $realtime_authorization$
BEGIN
  IF to_regclass('realtime.messages') IS NULL THEN
    RAISE NOTICE 'Realtime messages table is unavailable; clients must refetch persisted family safety state.';
    RETURN;
  END IF;

  BEGIN
    EXECUTE 'DROP POLICY IF EXISTS "Approved family members can receive family safety broadcasts" ON realtime.messages';
    EXECUTE $policy$
      CREATE POLICY "Approved family members can receive family safety broadcasts"
      ON realtime.messages
      FOR SELECT TO authenticated
      USING (
        realtime.messages.extension::text = 'broadcast'
        AND CASE
          WHEN (SELECT realtime.topic()) ~
            '^family:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}:safety$'
          THEN public.is_approved_family_member(
            split_part((SELECT realtime.topic()), ':', 2)::uuid
          )
          ELSE false
        END
      )
    $policy$;
  EXCEPTION
    WHEN insufficient_privilege OR undefined_column OR undefined_function THEN
      RAISE NOTICE 'Could not install family Realtime authorization; persisted state and push delivery remain available.';
  END;
END;
$realtime_authorization$;

CREATE OR REPLACE FUNCTION private.cleanup_family_safety_data()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_ended integer := 0;
  v_locations integer := 0;
  v_sessions integer := 0;
  v_alerts integer := 0;
  v_jobs integer := 0;
  v_tokens integer := 0;
BEGIN
  UPDATE public.family_driving_sessions AS driving
  SET
    status = 'ended',
    ended_at = statement_timestamp(),
    tracking_token_hash = NULL,
    tracking_token_expires_at = statement_timestamp(),
    updated_at = statement_timestamp()
  WHERE driving.status = 'active'
    AND (
      driving.tracking_token_expires_at <= statement_timestamp()
      OR driving.started_at < statement_timestamp() - interval '24 hours'
    );
  GET DIAGNOSTICS v_ended = ROW_COUNT;

  DELETE FROM public.family_live_locations AS location
  USING public.family_driving_sessions AS driving
  WHERE location.session_id = driving.id
    AND (
      driving.status <> 'active'
      OR location.recorded_at < statement_timestamp() - interval '24 hours'
    );
  GET DIAGNOSTICS v_locations = ROW_COUNT;

  DELETE FROM public.family_driving_sessions AS driving
  WHERE driving.status = 'ended'
    AND driving.ended_at < statement_timestamp() - interval '30 days';
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  DELETE FROM public.family_alerts AS alert
  WHERE alert.status = 'resolved'
    AND alert.resolved_at < statement_timestamp() - interval '90 days';
  GET DIAGNOSTICS v_alerts = ROW_COUNT;

  DELETE FROM private.notification_outbox AS job
  WHERE (job.status = 'sent' AND job.sent_at < statement_timestamp() - interval '7 days')
     OR (job.status = 'dead' AND job.updated_at < statement_timestamp() - interval '30 days');
  GET DIAGNOSTICS v_jobs = ROW_COUNT;

  DELETE FROM private.device_push_tokens AS token
  WHERE (NOT token.is_active AND token.updated_at < statement_timestamp() - interval '30 days')
     OR token.last_seen_at < statement_timestamp() - interval '180 days';
  GET DIAGNOSTICS v_tokens = ROW_COUNT;

  RETURN jsonb_build_object(
    'ended_sessions', v_ended,
    'deleted_locations', v_locations,
    'deleted_sessions', v_sessions,
    'deleted_alerts', v_alerts,
    'deleted_outbox_jobs', v_jobs,
    'deleted_push_tokens', v_tokens
  );
END;
$$;

REVOKE ALL ON FUNCTION private.cleanup_family_safety_data()
  FROM PUBLIC, anon, authenticated;

DO $schedule_cleanup$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM cron.job WHERE jobname = 'kalasag-clean-family-safety-data'
     ) THEN
    PERFORM cron.schedule(
      'kalasag-clean-family-safety-data',
      '17 3 * * *',
      'SELECT private.cleanup_family_safety_data()'
    );
  END IF;
EXCEPTION WHEN insufficient_privilege OR undefined_table OR undefined_function THEN
  RAISE NOTICE 'Family safety retention job was not scheduled; call private.cleanup_family_safety_data() from trusted maintenance.';
END;
$schedule_cleanup$;

COMMIT;
