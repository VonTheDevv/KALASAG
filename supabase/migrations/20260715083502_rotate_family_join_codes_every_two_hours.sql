-- Rotate family join codes on a two-hour lifecycle. Rotation is enforced in
-- Postgres so it continues when no browser or Android client is connected.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

ALTER TABLE public.families
  ADD COLUMN IF NOT EXISTS join_code_rotated_at timestamptz;

-- Existing codes begin a fresh two-hour window when this migration is applied.
UPDATE public.families
SET join_code_rotated_at = statement_timestamp()
WHERE join_code_rotated_at IS NULL;

ALTER TABLE public.families
  ALTER COLUMN join_code_rotated_at SET DEFAULT now(),
  ALTER COLUMN join_code_rotated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS families_join_code_rotation_due_idx
  ON public.families (join_code_rotated_at, id);

CREATE OR REPLACE FUNCTION private.generate_family_join_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_random_bytes bytea;
  v_random_value bigint;
  v_candidate text;
  v_attempt integer;
BEGIN
  FOR v_attempt IN 1..64 LOOP
    -- Rejection sampling avoids modulo bias while retaining the existing
    -- eight-digit numeric format.
    LOOP
      v_random_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
      v_random_value :=
        get_byte(v_random_bytes, 0)::bigint * 16777216
        + get_byte(v_random_bytes, 1)::bigint * 65536
        + get_byte(v_random_bytes, 2)::bigint * 256
        + get_byte(v_random_bytes, 3)::bigint;
      EXIT WHEN v_random_value < 4230000000;
    END LOOP;

    v_candidate := (10000000 + (v_random_value % 90000000))::text;

    IF NOT EXISTS (
      SELECT 1
      FROM public.families AS family
      WHERE family.join_code = v_candidate
    ) THEN
      RETURN v_candidate;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'Unable to allocate a unique family join code. Try again.'
    USING ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION private.generate_family_join_code()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.rotate_family_join_code_if_due(
  p_family_id uuid,
  p_reference_time timestamptz DEFAULT statement_timestamp()
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_rotated_at timestamptz;
  v_elapsed_periods bigint;
  v_effective_rotation_at timestamptz;
  v_candidate text;
  v_attempt integer;
BEGIN
  SELECT family.join_code_rotated_at
  INTO v_rotated_at
  FROM public.families AS family
  WHERE family.id = p_family_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_rotated_at > p_reference_time - interval '2 hours' THEN
    RETURN false;
  END IF;

  -- Preserve each family's original two-hour cadence if a cron run is late or
  -- the project resumes after downtime.
  v_elapsed_periods := greatest(
    1,
    floor(extract(epoch FROM (p_reference_time - v_rotated_at)) / 7200)::bigint
  );
  v_effective_rotation_at := v_rotated_at + (v_elapsed_periods * interval '2 hours');

  FOR v_attempt IN 1..64 LOOP
    v_candidate := private.generate_family_join_code();

    BEGIN
      UPDATE public.families AS family
      SET
        join_code = v_candidate,
        join_code_rotated_at = v_effective_rotation_at
      WHERE family.id = p_family_id;
      RETURN true;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt = 64 THEN
        RAISE EXCEPTION 'Unable to rotate the family join code. Try again.'
          USING ERRCODE = 'P0001';
      END IF;
    END;
  END LOOP;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION private.rotate_family_join_code_if_due(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.rotate_due_family_join_codes(
  p_limit integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_family_id uuid;
  v_reference_time timestamptz := statement_timestamp();
  v_rotated_count integer := 0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Rotation batch limit must be between 1 and 10000'
      USING ERRCODE = '22023';
  END IF;

  FOR v_family_id IN
    SELECT family.id
    FROM public.families AS family
    WHERE family.join_code_rotated_at <= v_reference_time - interval '2 hours'
    ORDER BY family.join_code_rotated_at, family.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF private.rotate_family_join_code_if_due(v_family_id, v_reference_time) THEN
      v_rotated_count := v_rotated_count + 1;
    END IF;
  END LOOP;

  RETURN v_rotated_count;
END;
$$;

REVOKE ALL ON FUNCTION private.rotate_due_family_join_codes(integer)
  FROM PUBLIC, anon, authenticated;

-- Hosts use this RPC to obtain an authoritative code and expiry timestamp. It
-- also closes a possible scheduler-delay gap by rotating this family on read.
CREATE OR REPLACE FUNCTION public.get_family_join_code(p_family_id uuid)
RETURNS TABLE (
  join_code text,
  rotated_at timestamptz,
  expires_at timestamptz,
  server_now timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_reference_time timestamptz := statement_timestamp();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.families AS family
    WHERE family.id = p_family_id
      AND family.host_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Only the family host can view the join code'
      USING ERRCODE = '42501';
  END IF;

  PERFORM private.rotate_family_join_code_if_due(p_family_id, v_reference_time);

  RETURN QUERY
  SELECT
    family.join_code,
    family.join_code_rotated_at,
    family.join_code_rotated_at + interval '2 hours',
    v_reference_time
  FROM public.families AS family
  WHERE family.id = p_family_id
    AND family.host_id = v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_family_join_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_family_join_code(uuid) TO authenticated;

-- Expired codes remain indistinguishable from unknown codes. This preserves
-- the existing anti-enumeration and per-account throttling behavior.
CREATE OR REPLACE FUNCTION public.join_family_by_code(
  p_join_code text,
  p_first_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_join_code text := btrim(coalesce(p_join_code, ''));
  v_first_name text;
  v_family_id uuid;
  v_host_id uuid;
  v_family_name text;
  v_window_started_at timestamptz;
  v_failed_attempts integer;
  v_locked_until timestamptz;
  v_new_failed_attempts integer;
  v_inserted_rows integer;
  v_retry_after integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF v_join_code !~ '^[0-9]{8}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired join code');
  END IF;

  -- Retain p_first_name in the signature for client compatibility, but never
  -- trust it. The stored name is derived from the authenticated account.
  v_first_name := public.canonical_user_first_name(v_user_id);

  INSERT INTO public.family_join_attempt_limits (user_id)
  VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT attempts.window_started_at, attempts.failed_attempts, attempts.locked_until
  INTO v_window_started_at, v_failed_attempts, v_locked_until
  FROM public.family_join_attempt_limits AS attempts
  WHERE attempts.user_id = v_user_id
  FOR UPDATE;

  IF v_locked_until IS NOT NULL AND v_locked_until > now() THEN
    v_retry_after := greatest(1, ceil(extract(epoch FROM (v_locked_until - now())))::integer);
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Too many invalid attempts. Try again later.',
      'retry_after_seconds', v_retry_after
    );
  END IF;

  IF v_window_started_at <= now() - interval '10 minutes' THEN
    UPDATE public.family_join_attempt_limits
    SET window_started_at = now(), failed_attempts = 0, locked_until = NULL, updated_at = now()
    WHERE user_id = v_user_id;
    v_failed_attempts := 0;
  END IF;

  SELECT family.id, family.host_id, family.name
  INTO v_family_id, v_host_id, v_family_name
  FROM public.families AS family
  WHERE family.join_code = v_join_code
    AND family.join_code_rotated_at > statement_timestamp() - interval '2 hours'
  FOR SHARE;

  IF v_family_id IS NULL THEN
    v_new_failed_attempts := v_failed_attempts + 1;
    UPDATE public.family_join_attempt_limits
    SET
      failed_attempts = v_new_failed_attempts,
      locked_until = CASE
        WHEN v_new_failed_attempts >= 5 THEN now() + interval '15 minutes'
        ELSE NULL
      END,
      updated_at = now()
    WHERE user_id = v_user_id;

    IF v_new_failed_attempts >= 5 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Too many invalid attempts. Try again later.',
        'retry_after_seconds', 900
      );
    END IF;

    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired join code');
  END IF;

  DELETE FROM public.family_join_attempt_limits WHERE user_id = v_user_id;

  IF v_host_id = v_user_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'You are already the host of this family'
    );
  END IF;

  INSERT INTO public.family_members (family_id, user_id, first_name, status)
  VALUES (v_family_id, v_user_id, v_first_name, 'pending')
  ON CONFLICT (family_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted_rows = ROW_COUNT;

  IF v_inserted_rows = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'You have already joined or requested to join this family'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'family_id', v_family_id,
    'family_name', v_family_name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.join_family_by_code(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_family_by_code(text, text) TO authenticated;

SELECT cron.schedule(
  'kalasag-rotate-family-join-codes',
  '* * * * *',
  'SELECT private.rotate_due_family_join_codes(5000)'
);

COMMIT;
