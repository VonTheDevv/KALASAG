-- KALASAG: security, live-data, and family-chat integrity fixes.
-- Applied against the live Supabase database on 2026-07-11.

-- The browser no longer uses the legacy custom OTP implementation. Keep its
-- historical records inaccessible while Supabase Auth handles recovery emails.
ALTER TABLE public.password_reset_otps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can insert OTP" ON public.password_reset_otps;
DROP POLICY IF EXISTS "Anyone can select own OTP" ON public.password_reset_otps;
DROP POLICY IF EXISTS "Anyone can delete own OTP" ON public.password_reset_otps;
REVOKE ALL ON TABLE public.password_reset_otps FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.check_otp_rate_limit(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_otp(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_otp(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_expired_otps() FROM PUBLIC, anon, authenticated;

-- Bring the message table in line with the fields used by the client.
ALTER TABLE public.family_messages
  ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS latitude numeric,
  ADD COLUMN IF NOT EXISTS longitude numeric,
  ADD COLUMN IF NOT EXISTS media_url text,
  ADD COLUMN IF NOT EXISTS media_path text;

UPDATE public.family_messages
SET message_type = 'text'
WHERE message_type IS NULL OR message_type NOT IN ('text', 'status_update', 'media', 'location');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'family_messages_message_type_check'
      AND conrelid = 'public.family_messages'::regclass
  ) THEN
    ALTER TABLE public.family_messages
      ADD CONSTRAINT family_messages_message_type_check
      CHECK (message_type IN ('text', 'status_update', 'media', 'location'));
  END IF;
END $$;

ALTER TABLE public.family_messages REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS family_members_user_family_idx
  ON public.family_members (user_id, family_id);
CREATE INDEX IF NOT EXISTS family_members_family_status_idx
  ON public.family_members (family_id, status);
CREATE INDEX IF NOT EXISTS family_messages_family_created_idx
  ON public.family_messages (family_id, created_at);
CREATE INDEX IF NOT EXISTS hazard_reports_created_at_idx
  ON public.hazard_reports (created_at DESC);

-- SECURITY DEFINER helpers are deliberately narrow, authenticate the caller,
-- use a safe search path, and are never executable by PUBLIC.
CREATE OR REPLACE FUNCTION public.is_family_host(p_family_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.families
    WHERE id = p_family_id AND host_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_approved_family_member(p_family_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.is_family_host(p_family_id)
    OR EXISTS (
      SELECT 1 FROM public.family_members
      WHERE family_id = p_family_id
        AND user_id = auth.uid()
        AND status = 'approved'
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_chat_media(p_family_folder text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_family_folder IS NULL
     OR p_family_folder !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN public.is_approved_family_member(p_family_folder::uuid);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_family_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT family_id FROM public.family_members WHERE user_id = auth.uid()
  UNION
  SELECT id FROM public.families WHERE host_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.get_my_approved_family_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT family_id FROM public.family_members
  WHERE user_id = auth.uid() AND status = 'approved'
  UNION
  SELECT id FROM public.families WHERE host_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.is_family_host(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_approved_family_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_chat_media(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_family_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_approved_family_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_family_host(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_approved_family_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_chat_media(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_family_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_approved_family_ids() TO authenticated;

-- Families: hosts manage their own record; current members can read it.
DROP POLICY IF EXISTS "Host can manage families" ON public.families;
DROP POLICY IF EXISTS "Members can view their families" ON public.families;
CREATE POLICY "Members can view their families" ON public.families
  FOR SELECT TO authenticated
  USING (id IN (SELECT public.get_my_family_ids()));
CREATE POLICY "Hosts can create families" ON public.families
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = host_id);
CREATE POLICY "Hosts can update families" ON public.families
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = host_id)
  WITH CHECK ((SELECT auth.uid()) = host_id);
CREATE POLICY "Hosts can delete families" ON public.families
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = host_id);

-- Family members: pending users see only their own request; approved members
-- and hosts see members of the relevant family.
DROP POLICY IF EXISTS "Host can manage members" ON public.family_members;
DROP POLICY IF EXISTS "Members can view family members" ON public.family_members;
DROP POLICY IF EXISTS "Users can update own safety" ON public.family_members;
DROP POLICY IF EXISTS "Users can leave family" ON public.family_members;
CREATE POLICY "Members can view appropriate family members" ON public.family_members
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.is_family_host(family_id)
    OR public.is_approved_family_member(family_id)
  );
CREATE POLICY "Hosts can create own membership" ON public.family_members
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND public.is_family_host(family_id)
  );
CREATE POLICY "Hosts can remove family members" ON public.family_members
  FOR DELETE TO authenticated
  USING (public.is_family_host(family_id));
CREATE POLICY "Users can leave their family" ON public.family_members
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Older families may predate the host membership row. Backfill it so hosts can
-- use the same safety-status and member list flows as every other member.
INSERT INTO public.family_members (family_id, user_id, first_name, status, safety_status)
SELECT family.id, family.host_id, '', 'approved', 'unknown'
FROM public.families AS family
ON CONFLICT (family_id, user_id) DO NOTHING;

-- Safety updates are routed through a function so a member cannot alter their
-- approval, family, or identity columns.
REVOKE UPDATE ON public.family_members FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_my_family_safety(
  p_family_id uuid,
  p_safety_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_safety_status NOT IN ('safe', 'unknown', 'in_danger') THEN
    RAISE EXCEPTION 'Invalid safety status';
  END IF;

  UPDATE public.family_members
  SET safety_status = p_safety_status,
      last_updated_safety = now()
  WHERE family_id = p_family_id
    AND user_id = auth.uid()
    AND status = 'approved';

  IF NOT FOUND THEN RAISE EXCEPTION 'Approved family membership not found'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_family_member(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  UPDATE public.family_members AS member
  SET status = 'approved'
  FROM public.families AS family
  WHERE member.id = p_member_id
    AND member.family_id = family.id
    AND family.host_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Host permission required'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_my_family_safety(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_family_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_my_family_safety(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_family_member(uuid) TO authenticated;

-- Chat messages are readable and writable only by approved members. The
-- author must always match the authenticated identity.
DROP POLICY IF EXISTS "Approved members can read messages" ON public.family_messages;
DROP POLICY IF EXISTS "Approved members can send messages" ON public.family_messages;
CREATE POLICY "Approved members can read messages" ON public.family_messages
  FOR SELECT TO authenticated
  USING (public.is_approved_family_member(family_id));
CREATE POLICY "Approved members can send messages" ON public.family_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND public.is_approved_family_member(family_id)
  );
CREATE POLICY "Message authors can delete their messages" ON public.family_messages
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Joining returns the family name, preventing the client from selecting a
-- family by its private join code before RLS authorizes access.
CREATE OR REPLACE FUNCTION public.join_family_by_code(p_join_code text, p_first_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_family_id uuid;
  v_host_id uuid;
  v_family_name text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_join_code !~ '^[0-9]{8}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid join code');
  END IF;

  SELECT id, host_id, name INTO v_family_id, v_host_id, v_family_name
  FROM public.families
  WHERE join_code = trim(p_join_code);

  IF v_family_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid join code');
  END IF;
  IF v_host_id = auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'You are already the host of this family');
  END IF;

  BEGIN
    INSERT INTO public.family_members (family_id, user_id, first_name, status)
    VALUES (v_family_id, auth.uid(), left(trim(coalesce(p_first_name, '')), 100), 'pending');
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'You have already joined or requested to join this family');
  END;

  RETURN jsonb_build_object('success', true, 'family_id', v_family_id, 'family_name', v_family_name);
END;
$$;
REVOKE ALL ON FUNCTION public.join_family_by_code(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_family_by_code(text, text) TO authenticated;

-- Ensure a report is attributed to its authenticated author.
DROP POLICY IF EXISTS "Allow authenticated insert on hazard_reports" ON public.hazard_reports;
CREATE POLICY "Authenticated users can create attributed hazard reports" ON public.hazard_reports
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- Private family media uses per-message short-lived signed URLs. Object paths
-- must be <family-id>/<user-id>/<filename>.
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat_media', 'chat_media', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS "Public Access" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload media" ON storage.objects;
DROP POLICY IF EXISTS "Approved members read chat media" ON storage.objects;
DROP POLICY IF EXISTS "Approved members upload chat media" ON storage.objects;
DROP POLICY IF EXISTS "Media authors delete chat media" ON storage.objects;
CREATE POLICY "Approved members read chat media" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'chat_media'
    AND public.can_access_chat_media((storage.foldername(name))[1])
  );
CREATE POLICY "Approved members upload chat media" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat_media'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND public.can_access_chat_media((storage.foldername(name))[1])
  );
CREATE POLICY "Media authors delete chat media" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'chat_media'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
  );
