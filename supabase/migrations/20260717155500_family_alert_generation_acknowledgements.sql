-- Treat every material re-notification as a new alert generation even though
-- the durable alert row keeps the same ID. Previous acknowledgements must not
-- suppress an escalation, and offline acknowledgements are bound to the exact
-- updated_at value the user actually saw.

BEGIN;

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
    -- Re-notify after the anti-spam interval, and immediately when the member
    -- materially changes the emergency reason, urgency, or source. In
    -- particular, urgent-authorities escalation must never wait 30 seconds.
    v_should_renotify :=
      v_alert.last_notified_at <= statement_timestamp() - interval '30 seconds'
      OR v_alert.source IS DISTINCT FROM p_source
      OR v_alert.urgency IS DISTINCT FROM v_urgency
      OR v_alert.reason IS DISTINCT FROM btrim(p_reason);

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

  IF v_should_renotify THEN
    -- This deletion and the alert update share the same row/advisory lock and
    -- transaction. A prior acknowledgement can therefore never hide the new
    -- generation from the unacknowledged-alert RPC.
    DELETE FROM public.family_alert_acknowledgements AS acknowledgement
    WHERE acknowledgement.alert_id = v_alert_id;
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

CREATE OR REPLACE FUNCTION public.acknowledge_family_alert_v2(
  p_alert_id uuid,
  p_alert_updated_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_family_id uuid;
  v_current_updated_at timestamptz;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_alert_id IS NULL OR p_alert_updated_at IS NULL THEN
    RAISE EXCEPTION 'Alert ID and version are required' USING ERRCODE = '22023';
  END IF;

  SELECT alert.family_id, alert.updated_at
  INTO v_family_id, v_current_updated_at
  FROM public.family_alerts AS alert
  WHERE alert.id = p_alert_id
    AND alert.status = 'active'
    AND alert.resolved_at IS NULL
  FOR UPDATE;

  IF v_family_id IS NULL OR NOT public.is_approved_family_member(v_family_id) THEN
    RAISE EXCEPTION 'Family alert not found' USING ERRCODE = '42501';
  END IF;
  IF v_current_updated_at IS DISTINCT FROM p_alert_updated_at THEN
    RETURN false;
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
        'version', 2,
        'type', 'family_alert_acknowledged',
        'alert_id', p_alert_id,
        'alert_updated_at', v_current_updated_at,
        'family_id', v_family_id,
        'user_id', v_user_id,
        'acknowledged_at', statement_timestamp()
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_family_alert_v2(uuid, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_family_alert_v2(uuid, timestamptz)
  TO authenticated;

-- The additional updated_at column is the public alert-generation contract.
DROP FUNCTION public.list_my_unacknowledged_family_alerts(integer);
CREATE FUNCTION public.list_my_unacknowledged_family_alerts(
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
  updated_at timestamptz,
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
    alert.updated_at,
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
  ORDER BY alert.updated_at DESC, alert.id DESC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_my_unacknowledged_family_alerts(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_my_unacknowledged_family_alerts(integer)
  TO authenticated;

COMMIT;
