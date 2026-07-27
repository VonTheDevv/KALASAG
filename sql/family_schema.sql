-- ==============================================================================
-- DO NOT DEPLOY: historical bootstrap script retained for reference only.
-- Its policies and SECURITY DEFINER join function are superseded by the ordered
-- files in supabase/migrations/. Re-running this file can weaken production RLS.
-- ==============================================================================
-- KALASAG Family "I Am Safe" Schema
-- ==============================================================================

-- 1. Families Table
CREATE TABLE IF NOT EXISTS public.families (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    join_code TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Family Members Table
CREATE TABLE IF NOT EXISTS public.family_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    first_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved'
    safety_status TEXT NOT NULL DEFAULT 'unknown', -- 'safe', 'unknown', 'in_danger'
    last_updated_safety TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(family_id, user_id)
);

-- 3. Family Messages Table (Local-First Offline Chat)
CREATE TABLE IF NOT EXISTS public.family_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    first_name TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_messages ENABLE ROW LEVEL SECURITY;

-- Enable Realtime
BEGIN;
  DROP PUBLICATION IF EXISTS supabase_realtime;
  CREATE PUBLICATION supabase_realtime;
COMMIT;
ALTER PUBLICATION supabase_realtime ADD TABLE public.family_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.family_members;

-- Helper function to avoid infinite recursion in RLS
CREATE OR REPLACE FUNCTION public.get_my_family_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT family_id FROM family_members WHERE user_id = auth.uid()
    UNION
    SELECT id FROM families WHERE host_id = auth.uid();
$$;

-- Helper function to get only families where the user is approved or the host
CREATE OR REPLACE FUNCTION public.get_my_approved_family_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT family_id FROM family_members WHERE user_id = auth.uid() AND status = 'approved'
    UNION
    SELECT id FROM families WHERE host_id = auth.uid();
$$;

-- Families RLS
DROP POLICY IF EXISTS "Host can manage families" ON public.families;
CREATE POLICY "Host can manage families" ON public.families
    FOR ALL TO authenticated
    USING ((SELECT auth.uid()) = host_id)
    WITH CHECK ((SELECT auth.uid()) = host_id);

DROP POLICY IF EXISTS "Members can view their families" ON public.families;
CREATE POLICY "Members can view their families" ON public.families
    FOR SELECT USING (id IN (SELECT public.get_my_family_ids()));

-- Family Members RLS
DROP POLICY IF EXISTS "Host can manage members" ON public.family_members;
CREATE POLICY "Host can manage members" ON public.family_members
    FOR ALL USING (family_id IN (SELECT id FROM public.families WHERE host_id = auth.uid()));

DROP POLICY IF EXISTS "Members can view family members" ON public.family_members;
CREATE POLICY "Members can view family members" ON public.family_members
    FOR SELECT USING (family_id IN (SELECT public.get_my_family_ids()));

DROP POLICY IF EXISTS "Users can update own safety" ON public.family_members;
CREATE POLICY "Users can update own safety" ON public.family_members
    FOR UPDATE USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can leave family" ON public.family_members;
CREATE POLICY "Users can leave family" ON public.family_members
    FOR DELETE USING (user_id = auth.uid());

-- Family Messages RLS
DROP POLICY IF EXISTS "Approved members can read messages" ON public.family_messages;
CREATE POLICY "Approved members can read messages" ON public.family_messages
    FOR SELECT USING (family_id IN (SELECT public.get_my_approved_family_ids()));

DROP POLICY IF EXISTS "Approved members can send messages" ON public.family_messages;
CREATE POLICY "Approved members can send messages" ON public.family_messages
    FOR INSERT WITH CHECK (family_id IN (SELECT public.get_my_approved_family_ids()));


-- ==============================================================================
-- SECURE JOIN FUNCTION
-- Allows users to join a family securely by 8-digit code without exposing the code to the public.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.join_family_by_code(p_join_code TEXT, p_first_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_family_id UUID;
    v_host_id UUID;
BEGIN
    -- Find the family
    SELECT id, host_id INTO v_family_id, v_host_id 
    FROM public.families 
    WHERE join_code = p_join_code;

    IF v_family_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid join code');
    END IF;

    -- Host cannot join their own family
    IF v_host_id = auth.uid() THEN
        RETURN jsonb_build_object('success', false, 'error', 'You are already the host of this family');
    END IF;

    -- Insert into members (will fail if already requested/joined due to UNIQUE constraint)
    BEGIN
        INSERT INTO public.family_members (family_id, user_id, first_name, status)
        VALUES (v_family_id, auth.uid(), p_first_name, 'pending');
    EXCEPTION WHEN unique_violation THEN
        RETURN jsonb_build_object('success', false, 'error', 'You have already joined or requested to join this family');
    END;

    RETURN jsonb_build_object('success', true, 'family_id', v_family_id);
END;
$$;

-- Grant access
REVOKE ALL ON TABLE public.families FROM anon;
REVOKE ALL ON TABLE public.family_members FROM anon;
REVOKE ALL ON TABLE public.family_messages FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.families TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.family_members TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.family_messages TO authenticated;
