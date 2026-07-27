-- ==============================================================================
-- DO NOT DEPLOY: insecure historical custom-OTP experiment.
-- Supabase Auth owns password recovery. The ordered migrations revoke and remove
-- these functions/tables because generate_otp returned reset codes to callers.
-- ==============================================================================
-- KALASAG — Password Reset with OTP + Rate Limiting
-- Run in Supabase SQL Editor
-- ==============================================================================

-- ── Password reset codes table ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.password_reset_codes (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email         TEXT NOT NULL,
    code          TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes')
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_password_reset_email ON public.password_reset_codes(email, created_at DESC);

-- ── Rate limiting function ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_otp_rate_limit(p_email TEXT)
RETURNS TABLE(can_send BOOLEAN, remaining INTEGER, cooldown_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    recent_count INTEGER;
    last_sent    TIMESTAMPTZ;
BEGIN
    -- Count OTPs sent to this email in the last 10 minutes
    SELECT COUNT(*), MAX(created_at)
    INTO recent_count, last_sent
    FROM public.password_reset_codes
    WHERE email = p_email
      AND created_at > (now() - interval '10 minutes');

    IF recent_count >= 3 THEN
        can_send := false;
        remaining := 0;
        cooldown_seconds := CEIL(EXTRACT(EPOCH FROM (last_sent + interval '10 minutes' - now())));
        IF cooldown_seconds < 0 THEN cooldown_seconds := 0; END IF;
    ELSE
        can_send := true;
        remaining := 3 - recent_count;
        cooldown_seconds := 0;
    END IF;

    RETURN NEXT;
END;
$$;

-- ── Generate OTP function ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_otp(p_email TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    otp_code TEXT;
    rate     RECORD;
BEGIN
    -- Check rate limit
    SELECT * INTO rate FROM public.check_otp_rate_limit(p_email);
    IF NOT rate.can_send THEN
        RAISE EXCEPTION 'Rate limited: try again in % seconds', rate.cooldown_seconds;
    END IF;

    -- Generate random 8-digit code
    otp_code := LPAD(FLOOR(RANDOM() * 100000000)::TEXT, 8, '0');

    -- Store the code
    INSERT INTO public.password_reset_codes (email, code)
    VALUES (p_email, otp_code);

    RETURN otp_code;
END;
$$;

-- ── Verify OTP function ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_otp(p_email TEXT, p_code TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    otp_record RECORD;
BEGIN
    -- Find the most recent valid code for this email
    SELECT * INTO otp_record
    FROM public.password_reset_codes
    WHERE email = p_email
      AND attempts < 5
      AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1;

    IF otp_record IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Increment attempt counter
    UPDATE public.password_reset_codes
    SET attempts = attempts + 1
    WHERE id = otp_record.id;

    -- Check if code matches
    IF otp_record.code = p_code THEN
        -- Mark as used (expire it immediately)
        UPDATE public.password_reset_codes
        SET expires_at = now()
        WHERE id = otp_record.id;
        RETURN TRUE;
    END IF;

    RETURN FALSE;
END;
$$;

-- ── Auto-cleanup old codes ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_expired_otps()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    DELETE FROM public.password_reset_codes WHERE expires_at < now();
END;
$$;

-- Schedule cleanup every hour (requires pg_cron extension — optional)
-- SELECT cron.schedule('cleanup-otps', '0 * * * *', 'SELECT public.cleanup_expired_otps()');

-- ── Grant execute to authenticated users ───────────────────────────
GRANT EXECUTE ON FUNCTION public.check_otp_rate_limit(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_otp(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_otp(TEXT, TEXT) TO authenticated;
