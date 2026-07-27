-- Close two offline/idempotency gaps in the family emergency workflow:
--   1. A queued acknowledgement for an alert that has already been resolved,
--      superseded, or made inaccessible is terminal and must not retry forever.
--   2. Replaying an already-accepted client event must not mutate the member's
--      current safety status after that emergency has been cleared.

BEGIN;

CREATE OR REPLACE FUNCTION private.mark_notification_deliveries_dead_with_outbox()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, private, pg_temp
AS $$
BEGIN
  IF NEW.status = 'dead' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE private.notification_outbox_deliveries AS delivery
    SET
      status = 'dead',
      last_error = left(coalesce(NEW.last_error, 'Parent notification job ended'), 1000),
      updated_at = statement_timestamp()
    WHERE delivery.outbox_id = NEW.id
      AND delivery.status IN ('pending', 'processing', 'retry');
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.mark_notification_deliveries_dead_with_outbox()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS mark_notification_deliveries_dead_with_outbox
  ON private.notification_outbox;
CREATE TRIGGER mark_notification_deliveries_dead_with_outbox
AFTER UPDATE OF status ON private.notification_outbox
FOR EACH ROW
EXECUTE FUNCTION private.mark_notification_deliveries_dead_with_outbox();

-- Repair any delivery rows stranded by an outbox job that became terminal
-- before this trigger existed.
UPDATE private.notification_outbox_deliveries AS delivery
SET
  status = 'dead',
  last_error = left(coalesce(job.last_error, 'Parent notification job ended'), 1000),
  updated_at = statement_timestamp()
FROM private.notification_outbox AS job
WHERE job.id = delivery.outbox_id
  AND job.status = 'dead'
  AND delivery.status IN ('pending', 'processing', 'retry');

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

  -- False is deliberately terminal for an authenticated caller. It reveals no
  -- alert details, and lets offline clients discard acknowledgements for an
  -- alert that was superseded, deleted, or belongs to a family they left.
  IF v_family_id IS NULL OR NOT public.is_approved_family_member(v_family_id) THEN
    RETURN false;
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
  IF p_client_event_id IS NULL THEN
    RAISE EXCEPTION 'Client event is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_family_id::text || ':' || v_user_id::text || ':alert', 0)
  );

  -- Idempotency is checked before changing safety state. In particular, a
  -- delayed retry of an old emergency cannot undo a later "safe" action.
  SELECT event.alert_id
  INTO v_alert_id
  FROM private.family_alert_client_events AS event
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

  -- Lock the membership before the idempotency decision. This retains the
  -- original approved-member contract without mutating the safety row.
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

  -- This is the same transaction-scoped key used by create_family_alert. It
  -- serializes danger retries with a later safe/unknown transition.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_family_id::text || ':' || v_user_id::text || ':alert', 0)
  );

  IF p_safety_status = 'in_danger' THEN
    SELECT event.alert_id
    INTO v_alert_id
    FROM private.family_alert_client_events AS event
    WHERE event.family_id = p_family_id
      AND event.user_id = v_user_id
      AND event.client_event_id = p_client_event_id;

    IF FOUND THEN
      RETURN v_alert_id;
    END IF;
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

COMMIT;
