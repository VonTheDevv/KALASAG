-- Close final family-safety lifecycle gaps:
--   * filter acknowledgements before limiting alerts;
--   * never carry a street label forward to new native coordinates;
--   * revoke all live/emergency state transactionally when membership ends.

BEGIN;

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
    -- Native collection has current coordinates but no trustworthy street.
    -- Clearing the previous label prevents a starting street from being shown
    -- beside a later position; viewers reverse-geocode the current point.
    address_label = EXCLUDED.address_label,
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

CREATE OR REPLACE FUNCTION public.list_my_unacknowledged_family_alerts(
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  id uuid,
  family_id uuid,
  reporter_user_id uuid,
  source text,
  urgency text,
  reason text,
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  address_label text,
  created_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Alert limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    alert.id,
    alert.family_id,
    alert.triggered_by AS reporter_user_id,
    alert.source,
    alert.urgency,
    alert.reason,
    alert.latitude,
    alert.longitude,
    alert.accuracy_m,
    alert.address_label,
    alert.created_at,
    alert.resolved_at,
    alert.resolved_by
  FROM public.family_alerts AS alert
  WHERE alert.status = 'active'
    AND alert.resolved_at IS NULL
    AND alert.triggered_by <> v_user_id
    AND (
      EXISTS (
        SELECT 1
        FROM public.families AS family
        WHERE family.id = alert.family_id
          AND family.host_id = v_user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.family_members AS member
        WHERE member.family_id = alert.family_id
          AND member.user_id = v_user_id
          AND member.status = 'approved'
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.family_alert_acknowledgements AS acknowledgement
      WHERE acknowledgement.alert_id = alert.id
        AND acknowledgement.user_id = v_user_id
    )
  ORDER BY alert.created_at DESC, alert.id DESC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_my_unacknowledged_family_alerts(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_my_unacknowledged_family_alerts(integer)
  TO authenticated;

CREATE OR REPLACE FUNCTION private.cleanup_removed_family_member_safety()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
BEGIN
  -- Remove queued payloads first because the outbox intentionally does not
  -- reference driving sessions or alerts with foreign keys.
  DELETE FROM private.notification_outbox AS job
  WHERE job.family_id = OLD.family_id
    AND (
      job.recipient_user_id = OLD.user_id
      OR (
        job.event_type = 'driving_started'
        AND EXISTS (
          SELECT 1
          FROM public.family_driving_sessions AS driving
          WHERE driving.id = job.event_id
            AND driving.family_id = OLD.family_id
            AND driving.user_id = OLD.user_id
        )
      )
      OR EXISTS (
        SELECT 1
        FROM public.family_alerts AS alert
        WHERE alert.id = job.event_id
          AND alert.family_id = OLD.family_id
          AND alert.triggered_by = OLD.user_id
      )
    );

  DELETE FROM public.family_live_locations AS location
  WHERE location.family_id = OLD.family_id
    AND location.user_id = OLD.user_id;

  UPDATE public.family_driving_sessions AS driving
  SET
    status = 'ended',
    ended_at = coalesce(driving.ended_at, statement_timestamp()),
    tracking_token_hash = NULL,
    tracking_token_expires_at = statement_timestamp(),
    updated_at = statement_timestamp()
  WHERE driving.family_id = OLD.family_id
    AND driving.user_id = OLD.user_id
    AND driving.status = 'active';

  -- Family emergency reasons and exact locations are private membership data.
  -- Delete them when that relationship ends; acknowledgements and idempotency
  -- records cascade from the alert.
  DELETE FROM public.family_alerts AS alert
  WHERE alert.family_id = OLD.family_id
    AND alert.triggered_by = OLD.user_id;

  BEGIN
    PERFORM private.broadcast_family_safety(
      OLD.family_id,
      'family_member_removed',
      jsonb_build_object(
        'version', 1,
        'type', 'family_member_removed',
        'family_id', OLD.family_id,
        'user_id', OLD.user_id
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION private.cleanup_removed_family_member_safety()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cleanup_family_safety_before_member_delete
  ON public.family_members;
CREATE TRIGGER cleanup_family_safety_before_member_delete
BEFORE DELETE ON public.family_members
FOR EACH ROW
EXECUTE FUNCTION private.cleanup_removed_family_member_safety();

CREATE OR REPLACE FUNCTION public.remove_family_member_v2(
  p_member_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_family_id uuid;
  v_member_user_id uuid;
  v_host_id uuid;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_member_id IS NULL THEN
    RAISE EXCEPTION 'Family member is required' USING ERRCODE = '22023';
  END IF;

  SELECT member.family_id, member.user_id, family.host_id
  INTO v_family_id, v_member_user_id, v_host_id
  FROM public.family_members AS member
  JOIN public.families AS family ON family.id = member.family_id
  WHERE member.id = p_member_id
  FOR UPDATE OF member;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Family member was not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_actor_id <> v_host_id AND v_actor_id <> v_member_user_id THEN
    RAISE EXCEPTION 'Only the host or the member can end this membership'
      USING ERRCODE = '42501';
  END IF;
  IF v_member_user_id = v_host_id THEN
    RAISE EXCEPTION 'The family host must delete the family instead'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.family_members AS member
  WHERE member.id = p_member_id;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_family_member_v2(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_family_member_v2(uuid)
  TO authenticated;

-- All membership deletion must pass through the lifecycle-safe RPC. The
-- trigger still protects trusted/admin deletes and cascade paths.
REVOKE DELETE ON TABLE public.family_members FROM PUBLIC, anon, authenticated;

COMMIT;
