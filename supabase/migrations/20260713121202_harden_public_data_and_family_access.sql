-- KALASAG security hardening follow-up.
--
-- This migration is deliberately idempotent: every policy, trigger, helper,
-- constraint, and privilege is recreated into the intended final state.
-- It does not depend on the legacy SQL scripts under /sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Remove the abandoned custom password-reset implementation.
-- Supabase Auth is the only supported password-recovery path.
-- ---------------------------------------------------------------------------

DO $revoke_legacy_otp$
BEGIN
  IF to_regprocedure('public.generate_otp(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.generate_otp(text) FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.verify_otp(text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.verify_otp(text,text) FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.check_otp_rate_limit(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.check_otp_rate_limit(text) FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.cleanup_expired_otps()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.cleanup_expired_otps() FROM PUBLIC, anon, authenticated';
  END IF;
END;
$revoke_legacy_otp$;

DROP FUNCTION IF EXISTS public.generate_otp(text);
DROP FUNCTION IF EXISTS public.verify_otp(text, text);
DROP FUNCTION IF EXISTS public.check_otp_rate_limit(text);
DROP FUNCTION IF EXISTS public.cleanup_expired_otps();
DROP TABLE IF EXISTS public.password_reset_codes;
DROP TABLE IF EXISTS public.password_reset_otps;

-- ---------------------------------------------------------------------------
-- 2. Constrain family and chat records at the database boundary.
-- NOT VALID preserves legacy rows while enforcing every new/updated row.
-- ---------------------------------------------------------------------------

-- An earlier host-membership backfill used an empty first name. Normalize only
-- those legacy placeholders so future safety-status updates remain valid.
UPDATE public.family_members AS member
SET first_name = CASE
  WHEN EXISTS (
    SELECT 1
    FROM public.families AS family
    WHERE family.id = member.family_id
      AND family.host_id = member.user_id
  ) THEN 'Host'
  ELSE 'Member'
END
WHERE btrim(member.first_name) = '';

DO $family_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'families_name_length_check'
      AND conrelid = 'public.families'::regclass
  ) THEN
    ALTER TABLE public.families
      ADD CONSTRAINT families_name_length_check
      CHECK (char_length(btrim(name)) BETWEEN 1 AND 100) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'families_join_code_format_check'
      AND conrelid = 'public.families'::regclass
  ) THEN
    ALTER TABLE public.families
      ADD CONSTRAINT families_join_code_format_check
      CHECK (join_code ~ '^[0-9]{8}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'family_members_first_name_length_check'
      AND conrelid = 'public.family_members'::regclass
  ) THEN
    ALTER TABLE public.family_members
      ADD CONSTRAINT family_members_first_name_length_check
      CHECK (char_length(btrim(first_name)) BETWEEN 1 AND 100) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'family_members_status_check'
      AND conrelid = 'public.family_members'::regclass
  ) THEN
    ALTER TABLE public.family_members
      ADD CONSTRAINT family_members_status_check
      CHECK (status IN ('pending', 'approved')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'family_members_safety_status_check'
      AND conrelid = 'public.family_members'::regclass
  ) THEN
    ALTER TABLE public.family_members
      ADD CONSTRAINT family_members_safety_status_check
      CHECK (safety_status IN ('safe', 'unknown', 'in_danger')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'family_messages_content_length_check'
      AND conrelid = 'public.family_messages'::regclass
  ) THEN
    ALTER TABLE public.family_messages
      ADD CONSTRAINT family_messages_content_length_check
      CHECK (char_length(btrim(content)) BETWEEN 1 AND 2000) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'family_messages_first_name_length_check'
      AND conrelid = 'public.family_messages'::regclass
  ) THEN
    ALTER TABLE public.family_messages
      ADD CONSTRAINT family_messages_first_name_length_check
      CHECK (char_length(btrim(first_name)) BETWEEN 1 AND 100) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'family_messages_location_payload_check'
      AND conrelid = 'public.family_messages'::regclass
  ) THEN
    ALTER TABLE public.family_messages
      ADD CONSTRAINT family_messages_location_payload_check
      CHECK (
        (
          message_type = 'location'
          AND latitude BETWEEN -90 AND 90
          AND longitude BETWEEN -180 AND 180
        )
        OR (
          message_type <> 'location'
          AND latitude IS NULL
          AND longitude IS NULL
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'family_messages_media_payload_check'
      AND conrelid = 'public.family_messages'::regclass
  ) THEN
    ALTER TABLE public.family_messages
      ADD CONSTRAINT family_messages_media_payload_check
      CHECK (
        (
          message_type = 'media'
          AND media_path IS NOT NULL
          AND char_length(media_path) <= 512
          AND media_path ~ (
            '^' || family_id::text || '/' || user_id::text ||
            '/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
          )
        )
        OR (message_type <> 'media' AND media_path IS NULL)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'family_messages_no_persisted_media_url_check'
      AND conrelid = 'public.family_messages'::regclass
  ) THEN
    ALTER TABLE public.family_messages
      ADD CONSTRAINT family_messages_no_persisted_media_url_check
      CHECK (media_url IS NULL) NOT VALID;
  END IF;
END;
$family_constraints$;

CREATE INDEX IF NOT EXISTS family_members_user_status_family_idx
  ON public.family_members (user_id, status, family_id);
CREATE INDEX IF NOT EXISTS family_messages_user_family_created_idx
  ON public.family_messages (user_id, family_id, created_at DESC);

-- Message writes are RPC-only. Revoke both table-level privileges inherited
-- from older migrations and the former per-column grant for idempotent upgrades.
REVOKE INSERT, UPDATE ON TABLE public.family_messages FROM anon, authenticated;
REVOKE INSERT (
  family_id,
  user_id,
  first_name,
  content,
  message_type,
  latitude,
  longitude,
  media_path
) ON TABLE public.family_messages FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Family access: pending applicants can see their own request, but never the
-- complete family row (especially join_code and host_id).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.canonical_user_first_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT left(coalesce((
    SELECT coalesce(
      nullif(btrim(profile.first_name), ''),
      nullif(btrim(account.raw_user_meta_data ->> 'first_name'), ''),
      nullif(split_part(account.email, '@', 1), '')
    )
    FROM auth.users AS account
    LEFT JOIN public.emergency_profiles AS profile ON profile.id = account.id
    WHERE account.id = p_user_id
  ), 'Member'), 100);
$$;

REVOKE ALL ON FUNCTION public.canonical_user_first_name(uuid) FROM PUBLIC, anon, authenticated;

-- Remove any legacy display-name spoofing from member and message rows. Names
-- shown in chat are always derived from the authenticated account thereafter.
UPDATE public.family_members AS member
SET first_name = public.canonical_user_first_name(member.user_id)
WHERE member.first_name IS DISTINCT FROM public.canonical_user_first_name(member.user_id);

UPDATE public.family_messages AS message
SET first_name = public.canonical_user_first_name(message.user_id)
WHERE message.first_name IS DISTINCT FROM public.canonical_user_first_name(message.user_id);

CREATE OR REPLACE FUNCTION public.get_my_family_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT member.family_id
  FROM public.family_members AS member
  WHERE auth.uid() IS NOT NULL
    AND member.user_id = auth.uid()
    AND member.status = 'approved'
  UNION
  SELECT family.id
  FROM public.families AS family
  WHERE auth.uid() IS NOT NULL
    AND family.host_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.get_my_approved_family_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.get_my_family_ids();
$$;

CREATE OR REPLACE FUNCTION public.get_my_family_summaries()
RETURNS TABLE (
  family_id uuid,
  family_name text,
  role text,
  member_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
  SELECT summary.family_id, summary.family_name, summary.role, summary.member_status
  FROM (
    SELECT
      family.id AS family_id,
      family.name AS family_name,
      'host'::text AS role,
      'approved'::text AS member_status
    FROM public.families AS family
    WHERE family.host_id = v_user_id

    UNION ALL

    SELECT
      family.id AS family_id,
      family.name AS family_name,
      'member'::text AS role,
      member.status::text AS member_status
    FROM public.family_members AS member
    JOIN public.families AS family ON family.id = member.family_id
    WHERE member.user_id = v_user_id
      AND family.host_id <> v_user_id
  ) AS summary
  ORDER BY summary.family_name, summary.family_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_family_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_approved_family_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_family_summaries() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_family_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_approved_family_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_family_summaries() TO authenticated;

DROP POLICY IF EXISTS "Host can manage families" ON public.families;
DROP POLICY IF EXISTS "Members can view their families" ON public.families;
DROP POLICY IF EXISTS "Approved members can view their families" ON public.families;
CREATE POLICY "Approved members can view their families" ON public.families
  FOR SELECT TO authenticated
  USING (
    host_id = (SELECT auth.uid())
    OR id IN (SELECT public.get_my_approved_family_ids())
  );

-- ---------------------------------------------------------------------------
-- 4. Create families atomically. The RPC owns join-code generation and host
-- membership creation, so a client cannot forge either field or leave a family
-- without its host membership row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_family(p_name text)
RETURNS TABLE (
  id uuid,
  name text,
  host_id uuid,
  join_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_family_name text := btrim(coalesce(p_name, ''));
  v_first_name text;
  v_random_bytes bytea;
  v_random_value bigint;
  v_join_code text;
  v_family_id uuid;
  v_attempt integer;
  v_hosted_count integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF char_length(v_family_name) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Family name must contain 1 to 100 characters'
      USING ERRCODE = '22023';
  END IF;

  -- Match the trigger's lock key so the three-family limit remains race-free
  -- whether a future trusted caller inserts directly or uses this RPC.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  SELECT count(*)::integer
  INTO v_hosted_count
  FROM public.families AS family
  WHERE family.host_id = v_user_id;

  IF v_hosted_count >= 3 THEN
    RAISE EXCEPTION 'You can create a maximum of 3 families.'
      USING ERRCODE = 'P0001';
  END IF;

  v_first_name := public.canonical_user_first_name(v_user_id);

  FOR v_attempt IN 1..20 LOOP
    -- Rejection sampling avoids modulo bias while retaining the existing
    -- eight-digit UX. gen_random_uuid supplies cryptographically random bytes.
    LOOP
      v_random_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
      v_random_value :=
        get_byte(v_random_bytes, 0)::bigint * 16777216
        + get_byte(v_random_bytes, 1)::bigint * 65536
        + get_byte(v_random_bytes, 2)::bigint * 256
        + get_byte(v_random_bytes, 3)::bigint;
      EXIT WHEN v_random_value < 4230000000;
    END LOOP;

    v_join_code := (10000000 + (v_random_value % 90000000))::text;

    BEGIN
      INSERT INTO public.families AS family (host_id, name, join_code)
      VALUES (v_user_id, v_family_name, v_join_code)
      RETURNING family.id INTO v_family_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt = 20 THEN
        RAISE EXCEPTION 'Unable to allocate a unique family join code. Try again.'
          USING ERRCODE = 'P0001';
      END IF;
    END;
  END LOOP;

  INSERT INTO public.family_members (
    family_id,
    user_id,
    first_name,
    status,
    safety_status
  )
  VALUES (
    v_family_id,
    v_user_id,
    v_first_name,
    'approved',
    'safe'
  );

  RETURN QUERY
  SELECT v_family_id, v_family_name, v_user_id, v_join_code;
END;
$$;

REVOKE ALL ON FUNCTION public.create_family(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_family(text) TO authenticated;

-- Family creation and membership insertion are RPC-only. Joining still uses
-- join_family_by_code(), which inserts the caller's pending membership itself.
REVOKE INSERT ON TABLE public.families FROM anon, authenticated;
REVOKE INSERT ON TABLE public.family_members FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Harden joining and throttle code guessing per authenticated account.
-- Edge/VPS middleware must additionally enforce per-IP limits.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.family_join_attempt_limits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.family_join_attempt_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.family_join_attempt_limits FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.join_family_by_code(
  p_join_code text,
  p_first_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
    RETURN jsonb_build_object('success', false, 'error', 'Invalid join code');
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
  WHERE family.join_code = v_join_code;

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

    RETURN jsonb_build_object('success', false, 'error', 'Invalid join code');
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

-- ---------------------------------------------------------------------------
-- 6. Family chat writes are RPC-only. Names and status announcements are
-- derived by the database and cannot be impersonated by browser payloads.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.send_family_message(
  p_family_id uuid,
  p_content text,
  p_message_type text DEFAULT 'text',
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_media_path text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  family_id uuid,
  user_id uuid,
  first_name text,
  content text,
  message_type text,
  created_at timestamptz,
  media_path text,
  latitude numeric,
  longitude numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_content text := btrim(coalesce(p_content, ''));
  v_message_type text := lower(btrim(coalesce(p_message_type, 'text')));
  v_first_name text;
  v_id uuid;
  v_created_at timestamptz;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT public.is_approved_family_member(p_family_id) THEN
    RAISE EXCEPTION 'Approved family membership required' USING ERRCODE = '42501';
  END IF;

  IF v_message_type NOT IN ('text', 'media', 'location') THEN
    RAISE EXCEPTION 'Invalid message type' USING ERRCODE = '22023';
  END IF;

  IF v_message_type = 'text' THEN
    IF char_length(v_content) NOT BETWEEN 1 AND 1000
       OR p_lat IS NOT NULL OR p_lng IS NOT NULL OR p_media_path IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid text message payload' USING ERRCODE = '22023';
    END IF;
  ELSIF v_message_type = 'location' THEN
    IF p_lat IS NULL OR p_lng IS NULL
       OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180
       OR p_media_path IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid location message payload' USING ERRCODE = '22023';
    END IF;
    v_content := 'Shared a location';
  ELSE
    IF p_lat IS NOT NULL OR p_lng IS NOT NULL
       OR p_media_path IS NULL
       OR p_media_path !~ (
         '^' || p_family_id::text || '/' || v_user_id::text ||
         '/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
       )
       OR NOT EXISTS (
         SELECT 1
         FROM storage.objects AS object
         WHERE object.bucket_id = 'chat_media'
           AND object.name = p_media_path
           AND object.owner_id = v_user_id::text
       ) THEN
      RAISE EXCEPTION 'Invalid or unavailable media message payload' USING ERRCODE = '22023';
    END IF;
    v_content := 'Shared media';
  END IF;

  v_first_name := public.canonical_user_first_name(v_user_id);

  INSERT INTO public.family_messages AS message (
    family_id,
    user_id,
    first_name,
    content,
    message_type,
    latitude,
    longitude,
    media_path
  )
  VALUES (
    p_family_id,
    v_user_id,
    v_first_name,
    v_content,
    v_message_type,
    CASE WHEN v_message_type = 'location' THEN p_lat ELSE NULL END,
    CASE WHEN v_message_type = 'location' THEN p_lng ELSE NULL END,
    CASE WHEN v_message_type = 'media' THEN p_media_path ELSE NULL END
  )
  RETURNING message.id, message.created_at INTO v_id, v_created_at;

  RETURN QUERY SELECT
    v_id,
    p_family_id,
    v_user_id,
    v_first_name,
    v_content,
    v_message_type,
    v_created_at,
    CASE WHEN v_message_type = 'media' THEN p_media_path ELSE NULL END,
    CASE WHEN v_message_type = 'location' THEN p_lat::numeric ELSE NULL END,
    CASE WHEN v_message_type = 'location' THEN p_lng::numeric ELSE NULL END;
END;
$$;

REVOKE ALL ON FUNCTION public.send_family_message(
  uuid, text, text, double precision, double precision, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_family_message(
  uuid, text, text, double precision, double precision, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_my_family_safety(
  p_family_id uuid,
  p_safety_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_first_name text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_safety_status NOT IN ('safe', 'unknown', 'in_danger') THEN
    RAISE EXCEPTION 'Invalid safety status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.family_members
  SET safety_status = p_safety_status,
      last_updated_safety = now(),
      first_name = public.canonical_user_first_name(v_user_id)
  WHERE family_id = p_family_id
    AND user_id = v_user_id
    AND status = 'approved'
  RETURNING first_name INTO v_first_name;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved family membership not found' USING ERRCODE = '42501';
  END IF;

  -- A safety update is life-critical state. Its notification is useful but
  -- best-effort: chat throttling or a chat-only failure must never roll the
  -- member's safety status back.
  BEGIN
    INSERT INTO public.family_messages (
      family_id,
      user_id,
      first_name,
      content,
      message_type
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
END;
$$;

REVOKE ALL ON FUNCTION public.set_my_family_safety(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_family_safety(uuid, text) TO authenticated;

-- Bound family-chat write volume and keep read/delete policies least-privileged.

CREATE OR REPLACE FUNCTION public.enforce_family_message_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_recent_count integer;
BEGIN
  IF auth.uid() IS NULL OR NEW.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Message author must match the authenticated user'
      USING ERRCODE = '28000';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.user_id::text || ':' || NEW.family_id::text, 0)
  );

  SELECT count(*)
  INTO v_recent_count
  FROM public.family_messages AS message
  WHERE message.user_id = NEW.user_id
    AND message.family_id = NEW.family_id
    AND message.created_at >= now() - interval '1 minute';

  IF v_recent_count >= 60 THEN
    RAISE EXCEPTION 'Family message rate limit exceeded. Try again shortly.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_family_message_rate_limit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS enforce_family_message_rate_limit_before_insert ON public.family_messages;
CREATE TRIGGER enforce_family_message_rate_limit_before_insert
  BEFORE INSERT ON public.family_messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_family_message_rate_limit();

DROP POLICY IF EXISTS "Approved members can read messages" ON public.family_messages;
DROP POLICY IF EXISTS "Approved members can send messages" ON public.family_messages;
DROP POLICY IF EXISTS "Message authors can delete their messages" ON public.family_messages;
DROP POLICY IF EXISTS "Approved message authors can delete their messages" ON public.family_messages;
CREATE POLICY "Approved members can read messages" ON public.family_messages
  FOR SELECT TO authenticated
  USING (public.is_approved_family_member(family_id));
CREATE POLICY "Approved members can send messages" ON public.family_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND public.is_approved_family_member(family_id)
  );
CREATE POLICY "Approved message authors can delete their messages" ON public.family_messages
  FOR DELETE TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND public.is_approved_family_member(family_id)
  );

-- ---------------------------------------------------------------------------
-- 7. Hazard reports: validated RPC-only writes and a public projection that
-- cannot disclose reporter identities.
-- ---------------------------------------------------------------------------

DO $hazard_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hazard_reports_type_check'
      AND conrelid = 'public.hazard_reports'::regclass
  ) THEN
    ALTER TABLE public.hazard_reports
      ADD CONSTRAINT hazard_reports_type_check
      CHECK (type IN (
        'Flood',
        'Fire',
        'Road Blocked',
        'Accident',
        'Infrastructure Damage',
        'Other'
      )) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hazard_reports_location_check'
      AND conrelid = 'public.hazard_reports'::regclass
  ) THEN
    ALTER TABLE public.hazard_reports
      ADD CONSTRAINT hazard_reports_location_check
      CHECK (lat BETWEEN 2 AND 25 AND lng BETWEEN 110 AND 135) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hazard_reports_description_length_check'
      AND conrelid = 'public.hazard_reports'::regclass
  ) THEN
    ALTER TABLE public.hazard_reports
      ADD CONSTRAINT hazard_reports_description_length_check
      CHECK (
        description IS NOT NULL
        AND char_length(btrim(description)) BETWEEN 1 AND 1000
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hazard_reports_upvotes_check'
      AND conrelid = 'public.hazard_reports'::regclass
  ) THEN
    ALTER TABLE public.hazard_reports
      ADD CONSTRAINT hazard_reports_upvotes_check
      CHECK (upvotes BETWEEN 0 AND 1000000) NOT VALID;
  END IF;
END;
$hazard_constraints$;

CREATE INDEX IF NOT EXISTS hazard_reports_user_created_idx
  ON public.hazard_reports (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.enforce_hazard_report_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_recent_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));

  SELECT count(*)
  INTO v_recent_count
  FROM public.hazard_reports AS report
  WHERE report.user_id = NEW.user_id
    AND report.created_at >= now() - interval '1 hour';

  IF v_recent_count >= 5 THEN
    RAISE EXCEPTION 'Hazard report rate limit exceeded. Try again later.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_hazard_report_rate_limit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS enforce_hazard_report_rate_limit_before_insert ON public.hazard_reports;
CREATE TRIGGER enforce_hazard_report_rate_limit_before_insert
  BEFORE INSERT ON public.hazard_reports
  FOR EACH ROW EXECUTE FUNCTION public.enforce_hazard_report_rate_limit();

CREATE OR REPLACE FUNCTION public.submit_hazard_report(
  p_type text,
  p_lat double precision,
  p_lng double precision,
  p_description text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_type text := btrim(coalesce(p_type, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_report_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF v_type NOT IN (
    'Flood',
    'Fire',
    'Road Blocked',
    'Accident',
    'Infrastructure Damage',
    'Other'
  ) THEN
    RAISE EXCEPTION 'Invalid hazard type' USING ERRCODE = '22023';
  END IF;

  IF p_lat IS NULL OR p_lng IS NULL
     OR p_lat NOT BETWEEN 2 AND 25
     OR p_lng NOT BETWEEN 110 AND 135 THEN
    RAISE EXCEPTION 'Hazard location is outside the supported region'
      USING ERRCODE = '22023';
  END IF;

  IF char_length(v_description) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Hazard description must contain 1 to 1000 characters'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.hazard_reports (
    user_id,
    type,
    lat,
    lng,
    description,
    upvotes
  )
  VALUES (
    v_user_id,
    v_type,
    p_lat,
    p_lng,
    v_description,
    0
  )
  RETURNING id INTO v_report_id;

  RETURN v_report_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_hazard_report(text, double precision, double precision, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_hazard_report(text, double precision, double precision, text)
  TO authenticated;

DROP POLICY IF EXISTS "Allow public select on hazard_reports" ON public.hazard_reports;
DROP POLICY IF EXISTS "Allow authenticated insert on hazard_reports" ON public.hazard_reports;
DROP POLICY IF EXISTS "Authenticated users can create attributed hazard reports" ON public.hazard_reports;
DROP POLICY IF EXISTS "Public can read recent hazard reports" ON public.hazard_reports;
CREATE POLICY "Public can read recent hazard reports" ON public.hazard_reports
  FOR SELECT TO anon, authenticated
  USING (created_at >= now() - interval '7 days');

REVOKE ALL ON TABLE public.hazard_reports FROM anon, authenticated;
GRANT SELECT (id, type, lat, lng, description, upvotes, created_at)
  ON TABLE public.hazard_reports TO anon, authenticated;

CREATE OR REPLACE VIEW public.public_hazard_reports
WITH (security_invoker = true)
AS
SELECT
  id,
  type,
  lat,
  lng,
  description,
  upvotes,
  created_at
FROM public.hazard_reports;

REVOKE ALL ON TABLE public.public_hazard_reports FROM PUBLIC;
GRANT SELECT ON TABLE public.public_hazard_reports TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Private chat media: bucket limits plus exact path, ownership, MIME, and
-- payload-size enforcement in Storage RLS.
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'chat_media',
  'chat_media',
  false,
  20971520,
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif',
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/quicktime'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Public Access" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload media" ON storage.objects;
DROP POLICY IF EXISTS "Approved members read chat media" ON storage.objects;
DROP POLICY IF EXISTS "Approved members upload chat media" ON storage.objects;
DROP POLICY IF EXISTS "Media authors delete chat media" ON storage.objects;

CREATE POLICY "Approved members read chat media" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'chat_media'
    AND array_length(storage.foldername(name), 1) = 2
    AND public.can_access_chat_media((storage.foldername(name))[1])
  );

CREATE POLICY "Approved members upload chat media" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat_media'
    AND char_length(name) <= 512
    AND array_length(storage.foldername(name), 1) = 2
    AND owner_id = (SELECT auth.uid())::text
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND public.can_access_chat_media((storage.foldername(name))[1])
    AND lower(storage.extension(name)) IN (
      'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif',
      'mp4', 'webm', 'ogg', 'mov'
    )
  );

CREATE POLICY "Media authors delete chat media" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'chat_media'
    AND array_length(storage.foldername(name), 1) = 2
    AND owner_id = (SELECT auth.uid())::text
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
  );

COMMIT;
