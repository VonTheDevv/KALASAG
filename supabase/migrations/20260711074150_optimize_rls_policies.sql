-- Resolve Supabase advisor RLS initialization-plan and duplicate-policy warnings.

DROP POLICY IF EXISTS "Users manage own user profile" ON public.user_profiles;
CREATE POLICY "Users manage own user profile" ON public.user_profiles
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS "Users manage own emergency profile" ON public.emergency_profiles;
CREATE POLICY "Users manage own emergency profile" ON public.emergency_profiles
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS "Users manage own QR codes" ON public.qr_codes;
CREATE POLICY "Users manage own QR codes" ON public.qr_codes
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users manage own preferences" ON public.user_preferences;
CREATE POLICY "Users manage own preferences" ON public.user_preferences
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Hosts can remove family members" ON public.family_members;
DROP POLICY IF EXISTS "Users can leave their family" ON public.family_members;
CREATE POLICY "Hosts or users can remove family members" ON public.family_members
  FOR DELETE TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.is_family_host(family_id)
  );
