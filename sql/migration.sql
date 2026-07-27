-- ==============================================================================
-- DO NOT DEPLOY: historical all-in-one bootstrap retained for reference only.
-- It contains superseded grants and policies. Apply only the ordered files in
-- supabase/migrations/ with the restricted migration runner.
-- ==============================================================================
-- KALASAG — Supabase PostgreSQL Migration v2
-- ==============================================================================
-- How to run:
--   1. Go to your Supabase dashboard → SQL Editor
--   2. Paste this entire file
--   3. Click "Run"
--
-- This creates:
--   • public.user_profiles      — core user account data
--   • public.emergency_profiles  — emergency QR profile per user
--   • public.qr_codes            — generated QR code records
--   • public.password_reset_otps — password reset OTP codes
--   • Row-Level Security (RLS) — users can only access their own rows
-- ==============================================================================

-- ── Extensions ─────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Clean up old tables if they exist ──────────────────────────────
DROP TABLE IF EXISTS public.emergency_qr_logs CASCADE;
DROP TABLE IF EXISTS public.password_reset_otps CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;
DROP TABLE IF EXISTS public.emergency_hotlines CASCADE;
DROP TABLE IF EXISTS public.volcanoes CASCADE;
DROP TABLE IF EXISTS public.user_preferences CASCADE;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

-- ==============================================================================
-- TABLE 1: user_profiles
-- Core account data linked to auth.users
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.user_profiles (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own user profile" ON public.user_profiles;
CREATE POLICY "Users manage own user profile"
    ON public.user_profiles
    FOR ALL
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- ==============================================================================
-- TABLE 2: emergency_profiles
-- Emergency QR medical profile
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.emergency_profiles (
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    first_name      TEXT NOT NULL DEFAULT '',
    middle_name     TEXT NOT NULL DEFAULT '',
    last_name       TEXT NOT NULL DEFAULT '',
    name_extension  TEXT NOT NULL DEFAULT '',
    blood_type      TEXT NOT NULL DEFAULT '',
    allergies       TEXT NOT NULL DEFAULT '',
    medications     TEXT NOT NULL DEFAULT '',
    conditions      TEXT NOT NULL DEFAULT '',
    contact_name    TEXT NOT NULL DEFAULT '',
    contact_number  TEXT NOT NULL DEFAULT '',
    contact_relation TEXT NOT NULL DEFAULT '',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.emergency_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own emergency profile" ON public.emergency_profiles;
CREATE POLICY "Users manage own emergency profile"
    ON public.emergency_profiles
    FOR ALL
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- ==============================================================================
-- TABLE 3: qr_codes
-- Generated QR code records
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.qr_codes (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    qr_data      JSONB NOT NULL DEFAULT '{}',
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.qr_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own QR codes" ON public.qr_codes;
CREATE POLICY "Users manage own QR codes"
    ON public.qr_codes
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ==============================================================================
-- TABLE 4: legacy password_reset_otps (Supabase Auth now owns password recovery)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.password_reset_otps (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email       TEXT NOT NULL,
    code        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.password_reset_otps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can insert OTP" ON public.password_reset_otps;
DROP POLICY IF EXISTS "Anyone can select own OTP" ON public.password_reset_otps;
DROP POLICY IF EXISTS "Anyone can delete own OTP" ON public.password_reset_otps;

CREATE INDEX IF NOT EXISTS idx_otp_email_code ON public.password_reset_otps(email, code);

-- ==============================================================================
-- TRIGGER: auto-create rows on user signup
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.user_profiles (id, email) VALUES (NEW.id, NEW.email);
    INSERT INTO public.emergency_profiles (id) VALUES (NEW.id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- ==============================================================================
-- TABLE 5: emergency_hotlines
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.emergency_hotlines (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    category_id     TEXT NOT NULL,
    category_label  TEXT NOT NULL,
    category_color  TEXT NOT NULL,
    agency_id       TEXT NOT NULL,
    name            TEXT NOT NULL,
    number          TEXT NOT NULL,
    alt             TEXT,
    available       TEXT NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.emergency_hotlines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public select on emergency_hotlines" ON public.emergency_hotlines;
CREATE POLICY "Allow public select on emergency_hotlines"
    ON public.emergency_hotlines FOR SELECT USING (true);

-- Seed Emergency Hotlines Data
INSERT INTO public.emergency_hotlines (category_id, category_label, category_color, agency_id, name, number, alt, available, description) VALUES
('national-emergency', 'National Emergency', '#e53e3e', 'ndrrmc', 'NDRRMC Operations Center', '911', '02-8911-5061', '24/7', 'National Disaster Risk Reduction & Management Council'),
('national-emergency', 'National Emergency', '#e53e3e', '911', 'Emergency Hotline (PH)', '911', NULL, '24/7', 'National emergency number – Police, Fire, Medical'),
('national-emergency', 'National Emergency', '#e53e3e', 'pnp', 'PNP Emergency Hotline', '117', '02-8722-0650', '24/7', 'Philippine National Police'),
('national-emergency', 'National Emergency', '#e53e3e', 'bfp', 'Bureau of Fire Protection', '160', '02-8426-0246', '24/7', 'Fire emergencies and rescue'),

('medical', 'Medical & Health', '#22c55e', 'redcross', 'Philippine Red Cross', '143', '02-8527-8385', '24/7', 'Disaster response, blood services, ambulance'),
('medical', 'Medical & Health', '#22c55e', 'doh', 'DOH Hotline', '1555', '02-8651-7800', '24/7', 'Department of Health – Health emergencies'),
('medical', 'Medical & Health', '#22c55e', 'eoc-doh', 'DOH Emergency Operations Center', '02-8711-1001', NULL, '24/7', 'Health emergency coordination'),
('medical', 'Medical & Health', '#22c55e', 'ambulance', 'National Ambulance (NAEMS)', '02-8882-4244', NULL, '24/7', 'National Ambulance Emergency Service'),

('coast-search', 'Coast Guard & Search', '#3b82f6', 'coastguard', 'Philippine Coast Guard', '02-8527-8481', '5151', '24/7', 'Maritime emergencies and sea rescue'),
('coast-search', 'Coast Guard & Search', '#3b82f6', 'paf-sar', 'PAF Search & Rescue', '02-8853-4011', NULL, '24/7', 'Philippine Air Force – air search & rescue'),

('utility', 'Utilities & Infrastructure', '#f6c90e', 'meralco', 'Meralco Emergency', '16211', '1800-10-16211', '24/7', 'Power outage, downed lines, electrical hazards'),
('utility', 'Utilities & Infrastructure', '#f6c90e', 'maynilad', 'Maynilad Emergency', '1626', NULL, '24/7', 'Water service interruptions, flooding, main breaks'),
('utility', 'Utilities & Infrastructure', '#f6c90e', 'mwd', 'Manila Water Emergency', '1627', NULL, '24/7', 'Water supply and sewer emergencies'),
('utility', 'Utilities & Infrastructure', '#f6c90e', 'dpwh', 'DPWH Action Center', '165-02', NULL, '24/7', 'Road damage, flood infrastructure, public works'),

('weather', 'Weather & Disaster Agencies', '#14b8a6', 'pagasa', 'PAGASA Weather Division', '02-8284-0800', NULL, '24/7', 'Weather, typhoon, and flood advisories'),
('weather', 'Weather & Disaster Agencies', '#14b8a6', 'phivolcs', 'PHIVOLCS', '02-8426-1468', NULL, 'Business hours', 'Earthquake and volcano monitoring'),
('weather', 'Weather & Disaster Agencies', '#14b8a6', 'mmda', 'MMDA Traffic & Flood Control', '136', '02-8882-0925', '24/7', 'Metro Manila flood alerts, traffic, road clearing');

-- ==============================================================================
-- TABLE 6: volcanoes
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.volcanoes (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    lat             DOUBLE PRECISION NOT NULL,
    lng             DOUBLE PRECISION NOT NULL,
    alert_level     INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'Normal',
    details         TEXT NOT NULL DEFAULT '',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.volcanoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public select on volcanoes" ON public.volcanoes;
CREATE POLICY "Allow public select on volcanoes"
    ON public.volcanoes FOR SELECT USING (true);

-- Seed Volcanoes Data
INSERT INTO public.volcanoes (id, name, lat, lng, alert_level, status, details) VALUES
('kanlaon', 'Kanlaon', 10.411, 123.132, 2, 'Increasing unrest', 'Elevated volcanic SO2 emission and continuous volcanic earthquakes. Keep out of 4km PDZ.'),
('mayon', 'Mayon', 13.254, 123.686, 1, 'Abnormal', 'Low-level unrest. No entry in the 6km Permanent Danger Zone.'),
('taal', 'Taal', 14.002, 120.993, 1, 'Abnormal', 'Low-level unrest. Phreatic and phreatomagmatic activity recorded.'),
('bulusan', 'Bulusan', 12.769, 124.052, 1, 'Abnormal', 'Hydrothermal unrest. Entry into the 4km PDZ is strictly prohibited.'),
('pinatubo', 'Pinatubo', 15.142, 120.350, 0, 'Normal', 'No significant volcanic unrest.'),
('hibok-hibok', 'Hibok-Hibok', 9.200, 124.673, 0, 'Normal', 'Normal monitoring levels.'),
('makiling', 'Makiling', 14.130, 121.200, 0, 'Normal', 'Normal monitoring levels. Non-active.'),
('banahaw', 'Banahaw', 14.066, 121.493, 0, 'Normal', 'No magmatic unrest.'),
('didicas', 'Didicas', 19.076, 122.202, 0, 'Normal', 'No significant activity.'),
('biliran', 'Biliran', 11.523, 124.533, 0, 'Normal', 'Normal monitoring levels.'),
('ragang', 'Ragang', 7.697, 124.509, 0, 'Normal', 'No significant activity.'),
('macaturing', 'Macaturing', 7.639, 124.321, 0, 'Normal', 'Normal monitoring levels.'),
('parker', 'Parker', 6.113, 124.892, 0, 'Normal', 'Normal monitoring levels.'),
('matutum', 'Matutum', 6.362, 125.074, 0, 'Normal', 'Normal monitoring levels.'),
('babuyan-claro', 'Babuyan Claro', 19.526, 121.940, 0, 'Normal', 'No recent unrest.'),
('smith', 'Smith', 19.539, 121.916, 0, 'Normal', 'No recent unrest.'),
('cagua', 'Cagua', 18.221, 122.115, 0, 'Normal', 'Normal monitoring levels.'),
('iriga', 'Iriga', 13.456, 123.455, 0, 'Normal', 'Normal monitoring levels.'),
('isAROG', 'Isarog', 13.659, 123.376, 0, 'Normal', 'Normal monitoring levels.'),
('cabalian', 'Cabalian', 10.285, 125.215, 0, 'Normal', 'Normal monitoring levels.'),
('leonard-kniaseff', 'Leonard Kniaseff', 7.382, 126.046, 0, 'Normal', 'Normal monitoring levels.'),
('musuan', 'Musuan', 7.876, 125.068, 0, 'Normal', 'Normal monitoring levels.'),
('bud-dajo', 'Bud Dajo', 6.012, 121.059, 0, 'Normal', 'Normal monitoring levels.')
ON CONFLICT (id) DO NOTHING;

-- ==============================================================================
-- TABLE 7: user_preferences
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.user_preferences (
    user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    settings        JSONB NOT NULL DEFAULT '{}',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own preferences" ON public.user_preferences;
CREATE POLICY "Users manage own preferences"
    ON public.user_preferences
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ==============================================================================
-- TABLE 8: evacuation_centers
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.evacuation_centers (
    id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name              TEXT NOT NULL,
    address           TEXT,
    lat               DOUBLE PRECISION NOT NULL,
    lng               DOUBLE PRECISION NOT NULL,
    status            TEXT NOT NULL DEFAULT 'Open',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.evacuation_centers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public select on evacuation_centers" ON public.evacuation_centers;
CREATE POLICY "Allow public select on evacuation_centers"
    ON public.evacuation_centers FOR SELECT USING (true);

-- Seed Evacuation Centers across the Philippines
INSERT INTO public.evacuation_centers (name, address, lat, lng, status) VALUES
-- Metro Manila
('Marikina Sports Center', 'McDonald Ave, Marikina, 1800 Metro Manila', 14.6300, 121.0963, 'Open'),
('Quezon Memorial Circle', 'Elliptical Rd, Diliman, Quezon City', 14.6515, 121.0493, 'Open'),
('PhilSports Arena', 'Capt. Henry P. Javier, Pasig', 14.5779, 121.0658, 'Open'),
('Rizal Memorial Stadium', 'Malate, Manila, 1004 Metro Manila', 14.5630, 120.9930, 'Open'),
('Cuneta Astrodome', 'Roxas Blvd, Pasay, Metro Manila', 14.5422, 120.9936, 'Open'),
('Quirino Grandstand & Rizal Park', 'Ermita, Manila, Metro Manila', 14.5826, 120.9760, 'Open'),
-- Luzon
('Burnham Park', 'Jose Abad Santos Dr, Baguio, Benguet', 16.4124, 120.5937, 'Open'),
('Bicol University Oval', 'Rizal St, Legazpi City, Albay', 13.1415, 123.7275, 'Open'),
('Jesse M. Robredo Coliseum', 'CBD II, Naga, Camarines Sur', 13.6276, 123.1895, 'Open'),
('Ilocos Norte Centennial Arena', 'Laoag City, Ilocos Norte', 18.1963, 120.5960, 'Open'),
('Pampanga Capitol Grounds', 'San Fernando, Pampanga', 15.0294, 120.6865, 'Open'),
-- Visayas
('Cebu City Sports Center', 'Osmeña Blvd, Cebu City, Cebu', 10.3060, 123.8935, 'Open'),
('Plaza Independencia', 'M.J. Cuenco Ave, Cebu City, Cebu', 10.2925, 123.9023, 'Open'),
('Fuente Osmeña Circle', 'Osmeña Blvd, Cebu City, Cebu', 10.3113, 123.8961, 'Open'),
('Panaad Park and Stadium', 'Mansilingan, Bacolod, Negros Occidental', 10.6450, 122.9696, 'Open'),
('Iloilo Sports Complex', 'La Paz, Iloilo City, Iloilo', 10.7161, 122.5623, 'Open'),
('Leyte Sports Development Center', 'Tacloban City, Leyte', 11.2384, 125.0000, 'Open'),
-- Mindanao
('People''s Park', 'Uy Bldg, 49 J. Palma Gil St, Davao City, Davao del Sur', 7.0706, 125.6083, 'Open'),
('Crocodile Park Open Grounds', 'Gadi Rd, Talomo, Davao City, Davao del Sur', 7.0984, 125.5786, 'Open'),
('Pelaez Sports Center', 'A. Velez St, Cagayan de Oro, Misamis Oriental', 8.4800, 124.6468, 'Open'),
('Zamboanga City Coliseum', 'Tetuan, Zamboanga City, Zamboanga del Sur', 6.9157, 122.0863, 'Open'),
('General Santos City Oval Plaza', 'General Santos City, South Cotabato', 6.1158, 125.1716, 'Open');

-- ==============================================================================
-- TABLE 9: hazard_reports
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.hazard_reports (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,
    lat             DOUBLE PRECISION NOT NULL,
    lng             DOUBLE PRECISION NOT NULL,
    description     TEXT,
    upvotes         INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.hazard_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public select on hazard_reports" ON public.hazard_reports;
CREATE POLICY "Allow public select on hazard_reports"
    ON public.hazard_reports FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow authenticated insert on hazard_reports" ON public.hazard_reports;
CREATE POLICY "Allow authenticated insert on hazard_reports"
    ON public.hazard_reports FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ==============================================================================
-- TABLE 10: historical_typhoons
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.historical_typhoons (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    local_name      TEXT NOT NULL,
    year            INTEGER NOT NULL,
    category        INTEGER NOT NULL,
    max_wind        INTEGER NOT NULL,
    pressure        INTEGER NOT NULL,
    signal          INTEGER,
    casualties      INTEGER,
    damage          TEXT,
    color           TEXT NOT NULL,
    track           JSONB NOT NULL DEFAULT '[]',
    wind_profile    JSONB NOT NULL DEFAULT '[]',
    pressure_profile JSONB NOT NULL DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.historical_typhoons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public select on historical_typhoons" ON public.historical_typhoons;
CREATE POLICY "Allow public select on historical_typhoons"
    ON public.historical_typhoons FOR SELECT USING (true);

-- Seed Historical Typhoons Data
INSERT INTO public.historical_typhoons (id, name, local_name, year, category, max_wind, pressure, signal, casualties, damage, color, track, wind_profile, pressure_profile) VALUES
('yolanda', 'Yolanda', 'Haiyan', 2013, 5, 315, 895, 4, 6300, '₱95.5 Billion', '#e53e3e', '[[7.5, 155], [8.5, 150], [9.0, 145], [9.5, 140], [10.0, 135], [10.5, 130], [11.0, 125], [11.2, 124.5], [11.5, 120], [12.5, 115], [14.0, 110]]'::jsonb, '[85, 130, 195, 250, 295, 315, 280, 230, 180, 120, 80]'::jsonb, '[1000, 980, 950, 920, 895, 885, 900, 930, 955, 975, 990]'::jsonb),
('odette', 'Odette', 'Rai', 2021, 5, 260, 915, 5, 405, '₱51.8 Billion', '#ff6b00', '[[5.0, 160], [6.5, 155], [7.5, 150], [8.0, 145], [8.5, 140], [9.0, 135], [9.5, 130], [10.0, 126], [10.5, 123], [11.0, 119], [12.0, 115]]'::jsonb, '[65, 100, 150, 200, 240, 260, 250, 220, 180, 140, 90]'::jsonb, '[1005, 990, 965, 940, 920, 915, 920, 940, 960, 975, 990]'::jsonb),
('rolly', 'Rolly', 'Goni', 2020, 5, 315, 884, 5, 32, '₱20.2 Billion', '#f59e0b', '[[8.0, 162], [9.0, 157], [10.0, 152], [11.0, 147], [12.0, 142], [12.5, 137], [13.0, 132], [13.2, 127], [13.5, 124], [14.0, 120], [15.0, 116]]'::jsonb, '[75, 120, 175, 240, 280, 315, 290, 250, 200, 150, 95]'::jsonb, '[1002, 985, 955, 925, 900, 884, 895, 920, 950, 970, 988]'::jsonb),
('pablo', 'Pablo', 'Bopha', 2012, 5, 280, 930, 4, 1901, '₱43.2 Billion', '#f6c90e', '[[4.0, 158], [5.0, 153], [5.5, 148], [6.0, 143], [6.5, 138], [7.0, 133], [7.5, 129], [8.0, 126], [8.5, 123], [9.0, 119], [10.0, 115]]'::jsonb, '[55, 95, 140, 200, 250, 280, 260, 220, 170, 120, 75]'::jsonb, '[1006, 992, 970, 945, 935, 930, 940, 955, 970, 982, 993]'::jsonb),
('lawin', 'Lawin', 'Haima', 2016, 5, 225, 900, 5, 18, '₱14.2 Billion', '#22c55e', '[[10.0, 155], [11.0, 150], [12.0, 145], [13.0, 140], [14.0, 136], [15.0, 132], [16.0, 128], [16.5, 124], [17.0, 121], [18.0, 118], [19.5, 114]]'::jsonb, '[60, 100, 145, 180, 210, 225, 215, 190, 155, 110, 70]'::jsonb, '[1004, 988, 965, 940, 915, 900, 910, 935, 960, 978, 990]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ==============================================================================
-- PERMISSIONS: Grant table access to anon and authenticated roles
-- ==============================================================================
GRANT ALL ON TABLE public.user_profiles TO anon, authenticated;
GRANT ALL ON TABLE public.emergency_profiles TO anon, authenticated;
GRANT ALL ON TABLE public.qr_codes TO anon, authenticated;
REVOKE ALL ON TABLE public.password_reset_otps FROM anon, authenticated;
GRANT ALL ON TABLE public.emergency_hotlines TO anon, authenticated;
GRANT ALL ON TABLE public.volcanoes TO anon, authenticated;
GRANT ALL ON TABLE public.user_preferences TO anon, authenticated;
GRANT ALL ON TABLE public.evacuation_centers TO anon, authenticated;
GRANT ALL ON TABLE public.hazard_reports TO anon, authenticated;
GRANT ALL ON TABLE public.historical_typhoons TO anon, authenticated;
