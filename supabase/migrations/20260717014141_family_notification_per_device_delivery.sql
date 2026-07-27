-- Track push delivery independently for every registered device. The original
-- outbox row is recipient-scoped, so treating one successful device as success
-- for the whole row could silently drop transient failures on other devices.
-- The versioned RPCs intentionally leave the legacy claim/completion pair
-- unchanged. The migration and dispatcher can therefore be deployed in either
-- order without interrupting the currently deployed worker.

BEGIN;

CREATE TABLE private.notification_outbox_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL
    REFERENCES private.notification_outbox(id) ON DELETE CASCADE,
  push_token_id uuid
    REFERENCES private.device_push_tokens(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  sent_at timestamptz,
  CONSTRAINT notification_outbox_deliveries_outbox_token_unique
    UNIQUE (outbox_id, push_token_id),
  CONSTRAINT notification_outbox_deliveries_status_check
    CHECK (status IN ('pending', 'processing', 'retry', 'sent', 'dead')),
  CONSTRAINT notification_outbox_deliveries_attempts_check
    CHECK (attempts BETWEEN 0 AND 20)
);

CREATE INDEX notification_outbox_deliveries_ready_idx
  ON private.notification_outbox_deliveries (outbox_id, next_attempt_at, id)
  WHERE status IN ('pending', 'retry');

-- PostgreSQL does not automatically index the referencing side of a foreign
-- key. This index also keeps token rotation/deletion from scanning the table.
CREATE INDEX notification_outbox_deliveries_push_token_idx
  ON private.notification_outbox_deliveries (push_token_id)
  WHERE push_token_id IS NOT NULL;

REVOKE ALL ON TABLE private.notification_outbox_deliveries
  FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE private.notification_outbox_deliveries IS
  'Private per-device state for retry-safe family notification delivery.';

-- An idempotent enqueue can explicitly reset an existing recipient outbox
-- row. Keep its device state consistent if that path is used.
CREATE OR REPLACE FUNCTION private.reset_notification_deliveries_on_outbox_reset()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, private, pg_temp
AS $$
BEGIN
  IF NEW.status = 'pending'
     AND NEW.attempts = 0
     AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.attempts IS DISTINCT FROM NEW.attempts) THEN
    UPDATE private.notification_outbox_deliveries AS delivery
    SET
      status = 'pending',
      attempts = 0,
      next_attempt_at = statement_timestamp(),
      provider_message_id = NULL,
      last_error = NULL,
      sent_at = NULL,
      updated_at = statement_timestamp()
    WHERE delivery.outbox_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.reset_notification_deliveries_on_outbox_reset()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER reset_notification_deliveries_after_outbox_reset
AFTER UPDATE OF status, attempts ON private.notification_outbox
FOR EACH ROW
EXECUTE FUNCTION private.reset_notification_deliveries_on_outbox_reset();

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

  -- Recover the recipient lease and its unfinished device attempts together.
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
    RETURNING job.id
  )
  SELECT coalesce(array_agg(claimed.id ORDER BY claimed.id), ARRAY[]::uuid[])
  INTO v_claimed_ids
  FROM claimed;

  IF cardinality(v_claimed_ids) = 0 THEN
    RETURN;
  END IF;

  -- Snapshot the recipient's active devices on the first claim. Successful
  -- devices remain terminal and are therefore omitted from every later retry.
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

  -- A token can be unregistered between attempts. Preserve the delivery audit
  -- row, but make that device terminal instead of retrying it forever.
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

CREATE OR REPLACE FUNCTION public.complete_family_notification_deliveries(
  p_job_id uuid,
  p_lease_token uuid,
  p_results jsonb
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_results jsonb := coalesce(p_results, '[]'::jsonb);
  v_expected integer;
  v_result_count integer;
  v_distinct_count integer;
  v_valid boolean;
  v_updated integer;
  v_total integer;
  v_sent integer;
  v_outstanding integer;
  v_next_attempt_at timestamptz;
  v_provider_message_id text;
  v_error text;
  v_job_status text;
BEGIN
  IF jsonb_typeof(v_results) <> 'array' OR jsonb_array_length(v_results) > 100 THEN
    RAISE EXCEPTION 'Delivery results must be an array with at most 100 entries'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM private.notification_outbox AS job
  WHERE job.id = p_job_id
    AND job.status = 'processing'
    AND job.lock_token = p_lease_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Notification delivery lease is invalid or expired'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_expected
  FROM private.notification_outbox_deliveries AS delivery
  WHERE delivery.outbox_id = p_job_id
    AND delivery.status = 'processing';

  SELECT
    count(*),
    count(DISTINCT item.value ->> 'delivery_id'),
    coalesce(bool_and(
      coalesce(jsonb_typeof(item.value) = 'object', false)
      AND coalesce(item.value ->> 'delivery_id', '') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND coalesce(jsonb_typeof(item.value -> 'success') = 'boolean', false)
      AND coalesce(jsonb_typeof(item.value -> 'permanent') = 'boolean', false)
    ), true)
  INTO v_result_count, v_distinct_count, v_valid
  FROM jsonb_array_elements(v_results) AS item(value);

  IF NOT v_valid OR v_result_count <> v_distinct_count OR v_result_count <> v_expected THEN
    RAISE EXCEPTION 'Delivery results do not match the claimed devices'
      USING ERRCODE = '22023';
  END IF;

  WITH result_rows AS (
    SELECT
      (item.value ->> 'delivery_id')::uuid AS delivery_id,
      (item.value ->> 'success')::boolean AS success,
      (item.value ->> 'permanent')::boolean AS permanent,
      nullif(item.value ->> 'provider_message_id', '') AS provider_message_id,
      nullif(item.value ->> 'error', '') AS error
    FROM jsonb_array_elements(v_results) AS item(value)
  )
  UPDATE private.notification_outbox_deliveries AS delivery
  SET
    status = CASE
      WHEN result.success THEN 'sent'
      WHEN result.permanent OR delivery.attempts >= 8 THEN 'dead'
      ELSE 'retry'
    END,
    next_attempt_at = CASE
      WHEN result.success OR result.permanent OR delivery.attempts >= 8
        THEN delivery.next_attempt_at
      ELSE statement_timestamp() + make_interval(
        secs => least(3600, (30 * power(2, greatest(0, delivery.attempts - 1)))::integer)
      )
    END,
    provider_message_id = CASE
      WHEN result.success THEN left(result.provider_message_id, 500)
      ELSE delivery.provider_message_id
    END,
    last_error = CASE
      WHEN result.success THEN NULL
      ELSE left(coalesce(result.error, 'Delivery failed'), 1000)
    END,
    sent_at = CASE WHEN result.success THEN statement_timestamp() ELSE NULL END,
    updated_at = statement_timestamp()
  FROM result_rows AS result
  WHERE delivery.id = result.delivery_id
    AND delivery.outbox_id = p_job_id
    AND delivery.status = 'processing';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_expected THEN
    RAISE EXCEPTION 'One or more delivery results are outside this lease'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE delivery.status = 'sent'),
    count(*) FILTER (WHERE delivery.status IN ('pending', 'processing', 'retry')),
    min(delivery.next_attempt_at) FILTER (WHERE delivery.status IN ('pending', 'retry')),
    max(delivery.provider_message_id) FILTER (WHERE delivery.status = 'sent'),
    string_agg(delivery.last_error, ' | ' ORDER BY delivery.updated_at DESC)
      FILTER (WHERE delivery.status <> 'sent' AND delivery.last_error IS NOT NULL)
  INTO
    v_total,
    v_sent,
    v_outstanding,
    v_next_attempt_at,
    v_provider_message_id,
    v_error
  FROM private.notification_outbox_deliveries AS delivery
  WHERE delivery.outbox_id = p_job_id;

  v_job_status := CASE
    WHEN v_outstanding > 0 THEN 'retry'
    WHEN v_total > 0 AND v_sent > 0 THEN 'sent'
    ELSE 'dead'
  END;

  UPDATE private.notification_outbox AS job
  SET
    status = v_job_status,
    next_attempt_at = CASE
      WHEN v_job_status = 'retry'
        THEN coalesce(v_next_attempt_at, statement_timestamp() + interval '30 seconds')
      ELSE job.next_attempt_at
    END,
    provider_message_id = CASE
      WHEN v_sent > 0 THEN left(v_provider_message_id, 500)
      ELSE job.provider_message_id
    END,
    last_error = CASE
      WHEN v_job_status = 'sent' THEN NULL
      WHEN v_total = 0 THEN 'Recipient has no active push-capable device'
      ELSE left(coalesce(v_error, 'Delivery failed'), 1000)
    END,
    sent_at = CASE
      WHEN v_job_status = 'sent' THEN coalesce(job.sent_at, statement_timestamp())
      ELSE NULL
    END,
    locked_at = NULL,
    lock_token = NULL,
    updated_at = statement_timestamp()
  WHERE job.id = p_job_id;

  RETURN v_job_status;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_family_notification_deliveries(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_family_notification_deliveries(uuid, uuid, jsonb)
  TO service_role;

COMMIT;
