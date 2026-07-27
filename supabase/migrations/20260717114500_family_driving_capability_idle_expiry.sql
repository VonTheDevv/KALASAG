-- Bound a lost/offline Driving Mode capability without interrupting an active
-- trip. Each accepted coordinate rolls a short idle window, while started_at
-- remains the immutable 18-hour hard cap. The client receives that hard cap so
-- its encrypted stop-only credential is never retained indefinitely.

BEGIN;

UPDATE public.family_driving_sessions AS driving
SET
  tracking_token_expires_at = least(
    driving.tracking_token_expires_at,
    statement_timestamp() + interval '15 minutes',
    driving.started_at + interval '18 hours'
  ),
  updated_at = statement_timestamp()
WHERE driving.status = 'active';

DROP POLICY IF EXISTS "Approved members can read family driving sessions"
  ON public.family_driving_sessions;
CREATE POLICY "Approved members can read active family driving sessions"
  ON public.family_driving_sessions
  FOR SELECT TO authenticated
  USING (
    public.is_approved_family_member(family_id)
    AND status = 'active'
    AND tracking_token_expires_at > statement_timestamp()
    AND started_at > statement_timestamp() - interval '18 hours'
  );

DROP POLICY IF EXISTS "Approved members can read family live locations"
  ON public.family_live_locations;
CREATE POLICY "Approved members can read current family live locations"
  ON public.family_live_locations
  FOR SELECT TO authenticated
  USING (
    public.is_approved_family_member(family_id)
    AND EXISTS (
      SELECT 1
      FROM public.family_driving_sessions AS driving
      WHERE driving.id = family_live_locations.session_id
        AND driving.family_id = family_live_locations.family_id
        AND driving.user_id = family_live_locations.user_id
        AND driving.status = 'active'
        AND driving.tracking_token_expires_at > statement_timestamp()
        AND driving.started_at > statement_timestamp() - interval '18 hours'
    )
  );

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

  UPDATE public.family_driving_sessions AS driving
  SET
    status = 'ended',
    ended_at = statement_timestamp(),
    tracking_token_hash = NULL,
    tracking_token_expires_at = statement_timestamp(),
    updated_at = statement_timestamp()
  WHERE driving.family_id = p_family_id
    AND driving.user_id = v_user_id
    AND driving.status = 'active'
    AND (
      driving.tracking_token_expires_at <= statement_timestamp()
      OR driving.started_at <= statement_timestamp() - interval '18 hours'
    );

  DELETE FROM public.family_live_locations AS location
  USING public.family_driving_sessions AS driving
  WHERE location.session_id = driving.id
    AND driving.family_id = p_family_id
    AND driving.user_id = v_user_id
    AND driving.status = 'ended';

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
      tracking_token_expires_at = least(
        statement_timestamp() + interval '15 minutes',
        driving.started_at + interval '18 hours'
      ),
      updated_at = statement_timestamp()
    WHERE driving.id = v_session.id;

    RETURN QUERY SELECT
      v_session.id,
      v_tracking_token,
      v_session.started_at + interval '18 hours';
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
    statement_timestamp() + interval '15 minutes'
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

  RETURN QUERY SELECT
    v_session.id,
    v_tracking_token,
    v_session.started_at + interval '18 hours';
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
    AND driving.started_at > statement_timestamp() - interval '18 hours'
    AND driving.tracking_token_hash = extensions.digest(p_tracking_token, 'sha256')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Driving session or tracking capability is invalid or expired'
      USING ERRCODE = '42501';
  END IF;
  v_user_id := v_session.user_id;

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
  SET
    last_location_at = p_recorded_at,
    tracking_token_expires_at = least(
      statement_timestamp() + interval '15 minutes',
      driving.started_at + interval '18 hours'
    ),
    updated_at = statement_timestamp()
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
    AND driving.started_at > statement_timestamp() - interval '18 hours'
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

COMMIT;
