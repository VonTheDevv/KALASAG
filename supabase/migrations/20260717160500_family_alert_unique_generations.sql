-- A material re-alert is a distinct emergency occurrence. Give it a new ID so
-- stale acknowledgements from both current and legacy clients can only ever
-- apply to the occurrence the user actually saw.

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
    v_should_renotify :=
      v_alert.last_notified_at <= statement_timestamp() - interval '30 seconds'
      OR v_alert.source IS DISTINCT FROM p_source
      OR v_alert.urgency IS DISTINCT FROM v_urgency
      OR v_alert.reason IS DISTINCT FROM btrim(p_reason);

    IF v_should_renotify THEN
      -- Resolve the prior occurrence before inserting the replacement so the
      -- one-active-alert partial unique index remains authoritative.
      UPDATE public.family_alerts AS alert
      SET
        status = 'resolved',
        resolved_at = statement_timestamp(),
        resolved_by = p_user_id,
        resolution_note = 'Superseded by a newer emergency alert',
        updated_at = statement_timestamp()
      WHERE alert.id = v_alert.id;

      -- Do not let an unclaimed retry deliver stale reason/location content
      -- after the replacement occurrence has been created.
      UPDATE private.notification_outbox AS job
      SET
        status = 'dead',
        locked_at = NULL,
        lock_token = NULL,
        last_error = 'Superseded by a newer family alert',
        updated_at = statement_timestamp()
      WHERE job.event_type = 'family_danger'
        AND job.event_id = v_alert.id
        AND job.status IN ('pending', 'retry', 'processing');

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
    ELSE
      -- Identical repeats inside the anti-spam window may refresh location but
      -- must not advance updated_at: clients use it as the occurrence version.
      UPDATE public.family_alerts AS alert
      SET
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
        END
      WHERE alert.id = v_alert.id
      RETURNING alert.* INTO v_alert;
    END IF;

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
    'version', 2,
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
      'family_danger', v_alert_id, p_family_id, p_user_id, v_payload, false
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

COMMIT;
