BEGIN;

-- pg_net queues this request inside the same transaction and performs it only
-- after commit. Closing or killing the initiating client after its safety RPC
-- therefore cannot cancel the dispatch kick.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Only claim work for recipients that can currently receive a push. The
-- previous implementation claimed no-device jobs with an empty delivery list;
-- completion then made those jobs terminal before a device could register.
-- Also attach every newly active token on each retry rather than freezing the
-- delivery set after the first attempt.
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
      AND EXISTS (
        SELECT 1
        FROM private.device_push_tokens AS active_token
        WHERE active_token.user_id = job.recipient_user_id
          AND active_token.is_active
      )
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

-- Protocol v3 is the only externally callable claim boundary. Its SECURITY
-- DEFINER owner may call the implementation above, while API roles may not.
REVOKE ALL ON FUNCTION public.claim_family_notification_deliveries(integer)
  FROM PUBLIC, anon, authenticated, service_role;

-- Refreshing a device token makes queued work immediately eligible. A danger
-- alert that was previously made terminal solely because no token existed is
-- revived only when the exact alert generation is still unresolved.
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

  UPDATE private.notification_outbox AS job
  SET
    status = 'pending',
    next_attempt_at = statement_timestamp(),
    locked_at = NULL,
    lock_token = NULL,
    last_error = NULL,
    updated_at = statement_timestamp()
  WHERE job.recipient_user_id = v_user_id
    AND job.event_type = 'family_danger'
    AND job.status = 'dead'
    AND job.last_error = 'Recipient has no active push-capable device'
    AND job.superseded_at IS NULL
    -- Do not resurrect indefinitely retained historical alarms when an old
    -- installation registers again. FCM's longest supported TTL is 28 days;
    -- the small two-day margin covers dispatch and token-registration races.
    AND job.created_at >= statement_timestamp() - interval '30 days'
    AND EXISTS (
      SELECT 1
      FROM public.family_alerts AS alert
      WHERE alert.id = job.event_id
        AND alert.family_id = job.family_id
        AND alert.resolved_at IS NULL
        AND alert.updated_at = (job.payload ->> 'updated_at')::timestamptz
    );

  UPDATE private.notification_outbox AS job
  SET
    next_attempt_at = statement_timestamp(),
    updated_at = statement_timestamp()
  WHERE job.recipient_user_id = v_user_id
    AND job.status IN ('pending', 'retry')
    AND job.superseded_at IS NULL;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.register_family_push_token(uuid, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_family_push_token(uuid, text, text, text)
  TO authenticated;

-- The request headers are supplied by PostgREST for authenticated safety RPCs.
-- Forward only the two authentication headers; never place alert payloads or
-- device tokens in pg_net. pg_net removes the queued request after processing.
CREATE OR REPLACE FUNCTION private.kick_family_alert_dispatch_after_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, net, private, pg_temp
AS $$
DECLARE
  v_headers jsonb;
  v_authorization text;
  v_api_key text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inserted_jobs) THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  v_authorization := nullif(btrim(coalesce(v_headers ->> 'authorization', '')), '');
  v_api_key := nullif(btrim(coalesce(v_headers ->> 'apikey', '')), '');

  IF v_authorization IS NULL
     OR char_length(v_authorization) NOT BETWEEN 27 AND 8200
     OR v_authorization !~ '^Bearer [A-Za-z0-9._~-]+$'
     OR v_api_key IS NULL
     OR char_length(v_api_key) NOT BETWEEN 20 AND 4096
     OR v_api_key !~ '^[A-Za-z0-9._~-]+$' THEN
    RETURN NULL;
  END IF;

  PERFORM net.http_post(
    url := 'https://arkvqihazxrfdxuwzqur.supabase.co/functions/v1/family-alert-dispatch',
    body := '{"batchSize":10}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', v_authorization,
      'apikey', v_api_key
    ),
    timeout_milliseconds := 10000
  );

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Notification dispatch is durable best effort. A transient pg_net failure
  -- must never roll back the family member's committed emergency state.
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.kick_family_alert_dispatch_after_insert()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS kick_family_alert_dispatch_after_insert
  ON private.notification_outbox;
CREATE TRIGGER kick_family_alert_dispatch_after_insert
AFTER INSERT ON private.notification_outbox
REFERENCING NEW TABLE AS inserted_jobs
FOR EACH STATEMENT
EXECUTE FUNCTION private.kick_family_alert_dispatch_after_insert();

COMMIT;
