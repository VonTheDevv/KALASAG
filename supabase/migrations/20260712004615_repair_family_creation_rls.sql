-- Repair family creation policies in deployments where the family schema and
-- the hardened RLS migration were applied out of order.

BEGIN;

ALTER TABLE public.families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_members ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.families FROM anon;
REVOKE ALL ON TABLE public.family_members FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.families TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.family_members TO authenticated;

DROP POLICY IF EXISTS "Host can manage families" ON public.families;
DROP POLICY IF EXISTS "Members can view their families" ON public.families;
DROP POLICY IF EXISTS "Hosts can create families" ON public.families;
DROP POLICY IF EXISTS "Hosts can update families" ON public.families;
DROP POLICY IF EXISTS "Hosts can delete families" ON public.families;

CREATE POLICY "Members can view their families" ON public.families
  FOR SELECT TO authenticated
  USING (
    host_id = (SELECT auth.uid())
    OR id IN (SELECT public.get_my_family_ids())
  );

CREATE POLICY "Hosts can create families" ON public.families
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) IS NOT NULL
    AND (SELECT auth.uid()) = host_id
  );

CREATE POLICY "Hosts can update families" ON public.families
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = host_id)
  WITH CHECK ((SELECT auth.uid()) = host_id);

CREATE POLICY "Hosts can delete families" ON public.families
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = host_id);

DROP POLICY IF EXISTS "Hosts can create own membership" ON public.family_members;
CREATE POLICY "Hosts can create own membership" ON public.family_members
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) IS NOT NULL
    AND user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.families AS family
      WHERE family.id = family_id
        AND family.host_id = (SELECT auth.uid())
    )
  );

COMMIT;
