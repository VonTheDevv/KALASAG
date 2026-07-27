-- A user may host at most three families. Existing rows are left untouched;
-- the guard prevents only new rows beyond the quota.

CREATE OR REPLACE FUNCTION public.enforce_family_host_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  hosted_count integer;
BEGIN
  -- Serialize family creation for this host so concurrent requests cannot
  -- both observe the same pre-insert count and exceed the quota.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.host_id::text, 0));

  SELECT count(*)::integer
  INTO hosted_count
  FROM public.families
  WHERE host_id = NEW.host_id;

  IF hosted_count >= 3 THEN
    RAISE EXCEPTION 'You can create a maximum of 3 families.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_family_host_limit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enforce_family_host_limit() TO authenticated;

DROP TRIGGER IF EXISTS enforce_family_host_limit_before_insert ON public.families;
CREATE TRIGGER enforce_family_host_limit_before_insert
  BEFORE INSERT ON public.families
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_family_host_limit();
