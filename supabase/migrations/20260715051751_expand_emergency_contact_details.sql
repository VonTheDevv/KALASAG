-- Expand emergency contact details without removing the legacy combined name.
-- Existing clients can continue reading contact_name while updated clients use
-- the structured fields below.

ALTER TABLE public.emergency_profiles
  ADD COLUMN IF NOT EXISTS contact_first_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_middle_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_last_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS street_address text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS city text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS postal_code text NOT NULL DEFAULT '';

WITH parsed_contacts AS (
  SELECT
    id,
    regexp_split_to_array(
      regexp_replace(btrim(contact_name), '\s+', ' ', 'g'),
      ' '
    ) AS name_parts
  FROM public.emergency_profiles
  WHERE nullif(btrim(contact_name), '') IS NOT NULL
)
UPDATE public.emergency_profiles AS profile
SET
  contact_first_name = parsed.name_parts[1],
  contact_middle_name = CASE
    WHEN array_length(parsed.name_parts, 1) >= 3
      THEN array_to_string(parsed.name_parts[2:array_length(parsed.name_parts, 1) - 1], ' ')
    ELSE ''
  END,
  contact_last_name = CASE
    WHEN array_length(parsed.name_parts, 1) >= 2
      THEN parsed.name_parts[array_length(parsed.name_parts, 1)]
    ELSE ''
  END
FROM parsed_contacts AS parsed
WHERE profile.id = parsed.id
  AND nullif(btrim(profile.contact_first_name), '') IS NULL
  AND nullif(btrim(profile.contact_middle_name), '') IS NULL
  AND nullif(btrim(profile.contact_last_name), '') IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'emergency_profiles_contact_number_format_check'
      AND conrelid = 'public.emergency_profiles'::regclass
  ) THEN
    ALTER TABLE public.emergency_profiles
      ADD CONSTRAINT emergency_profiles_contact_number_format_check
      CHECK (contact_number = '' OR contact_number ~ '^[0-9]{11}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'emergency_profiles_postal_code_format_check'
      AND conrelid = 'public.emergency_profiles'::regclass
  ) THEN
    ALTER TABLE public.emergency_profiles
      ADD CONSTRAINT emergency_profiles_postal_code_format_check
      CHECK (postal_code = '' OR postal_code ~ '^[0-9]{4}$') NOT VALID;
  END IF;
END
$$;

COMMENT ON COLUMN public.emergency_profiles.contact_name IS
  'Legacy combined emergency-contact name retained for backward compatibility.';
COMMENT ON COLUMN public.emergency_profiles.street_address IS
  'Emergency contact street or building address selected from search or entered manually.';
