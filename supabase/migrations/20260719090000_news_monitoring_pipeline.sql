BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE public.news_sources (
  source_id text PRIMARY KEY,
  source_name text NOT NULL,
  source_home_url text NOT NULL,
  ingestion_status text NOT NULL
    CHECK (ingestion_status IN ('enabled', 'disabled_pending_permission')),
  health_status text NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('live', 'unknown', 'unavailable', 'disabled')),
  status_detail text NOT NULL,
  poll_interval_seconds integer NOT NULL
    CHECK (poll_interval_seconds BETWEEN 45 AND 86400),
  transport text NOT NULL,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  etag text,
  last_modified text,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT news_sources_home_url_https
    CHECK (source_home_url ~ '^https://[A-Za-z0-9.-]+(?:/|$)'),
  CONSTRAINT news_sources_lengths
    CHECK (
      char_length(source_id) BETWEEN 2 AND 64
      AND char_length(source_name) BETWEEN 2 AND 100
      AND char_length(status_detail) BETWEEN 1 AND 500
      AND char_length(transport) BETWEEN 2 AND 80
      AND (last_error IS NULL OR char_length(last_error) <= 300)
      AND (etag IS NULL OR char_length(etag) <= 500)
      AND (last_modified IS NULL OR char_length(last_modified) <= 200)
    )
);

CREATE TABLE public.news_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES public.news_sources(source_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  source_name text NOT NULL,
  source_home_url text NOT NULL,
  canonical_url text NOT NULL UNIQUE,
  title text NOT NULL,
  summary text,
  author text,
  published_at timestamptz NOT NULL,
  first_detected_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  transport text NOT NULL,
  category text CHECK (
    category IS NULL OR category IN (
      'fire',
      'flood',
      'road-incident',
      'typhoon',
      'earthquake',
      'other-disaster'
    )
  ),
  is_hazard boolean NOT NULL DEFAULT false,
  incident_expires_at timestamptz,
  resolved_at timestamptz,
  location_name text,
  location_query text,
  location_precision text CHECK (
    location_precision IS NULL OR location_precision IN ('street', 'locality', 'region', 'offshore')
  ),
  location_confidence numeric(4, 3) CHECK (
    location_confidence IS NULL OR location_confidence BETWEEN 0 AND 1
  ),
  latitude double precision,
  longitude double precision,
  location_resolution_status text NOT NULL DEFAULT 'not-required'
    CHECK (location_resolution_status IN ('not-required', 'pending', 'mapped', 'unresolved')),
  geocoding_attempted_at timestamptz,
  verification_status text NOT NULL DEFAULT 'news-reported'
    CHECK (verification_status IN ('news-reported', 'multiple-outlets-reported')),
  corroborating_sources text[] NOT NULL DEFAULT ARRAY[]::text[],
  proximity_alert_eligible boolean NOT NULL DEFAULT false
    CHECK (proximity_alert_eligible = false),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT news_articles_urls_https
    CHECK (
      source_home_url ~ '^https://[A-Za-z0-9.-]+(?:/|$)'
      AND canonical_url ~ '^https://[A-Za-z0-9.-]+(?:/|$)'
    ),
  CONSTRAINT news_articles_lengths
    CHECK (
      char_length(source_name) BETWEEN 2 AND 100
      AND char_length(canonical_url) BETWEEN 12 AND 2048
      AND char_length(title) BETWEEN 1 AND 280
      AND (summary IS NULL OR char_length(summary) <= 600)
      AND (author IS NULL OR char_length(author) <= 160)
      AND char_length(transport) BETWEEN 2 AND 80
      AND (location_name IS NULL OR char_length(location_name) <= 160)
      AND (location_query IS NULL OR char_length(location_query) <= 160)
    ),
  CONSTRAINT news_articles_location_complete
    CHECK (
      (latitude IS NULL AND longitude IS NULL)
      OR (
        latitude BETWEEN 4.5 AND 21.5
        AND longitude BETWEEN 116 AND 127.5
        AND location_confidence >= 0.7
        AND location_name IS NOT NULL
      )
    ),
  CONSTRAINT news_articles_location_status_consistent
    CHECK (
      (location_resolution_status = 'mapped' AND latitude IS NOT NULL AND longitude IS NOT NULL)
      OR (
        location_resolution_status <> 'mapped'
        AND latitude IS NULL
        AND longitude IS NULL
      )
    ),
  CONSTRAINT news_articles_hazard_consistency
    CHECK (
      (NOT is_hazard AND category IS NULL AND incident_expires_at IS NULL)
      OR (is_hazard AND category IS NOT NULL AND incident_expires_at IS NOT NULL)
    ),
  CONSTRAINT news_articles_time_order
    CHECK (
      published_at <= last_seen_at + interval '15 minutes'
      AND first_detected_at <= last_seen_at + interval '15 minutes'
      AND (incident_expires_at IS NULL OR incident_expires_at > published_at)
      AND (resolved_at IS NULL OR is_hazard)
    )
);

CREATE INDEX news_articles_published_idx
  ON public.news_articles (published_at DESC, id);
CREATE INDEX news_articles_active_hazard_idx
  ON public.news_articles (incident_expires_at DESC, category, published_at DESC)
  WHERE is_hazard;
CREATE INDEX news_articles_source_idx
  ON public.news_articles (source_id, published_at DESC);

ALTER TABLE public.news_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.news_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_articles FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.news_sources FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.news_articles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.news_sources TO authenticated;
GRANT SELECT ON TABLE public.news_articles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.news_sources TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.news_articles TO service_role;

CREATE POLICY "Authenticated users can read news source health"
  ON public.news_sources
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL);

CREATE POLICY "Authenticated users can read normalized news metadata"
  ON public.news_articles
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL);

INSERT INTO public.news_sources (
  source_id,
  source_name,
  source_home_url,
  ingestion_status,
  health_status,
  status_detail,
  poll_interval_seconds,
  transport
)
VALUES
  (
    'gma-news',
    'GMA News',
    'https://www.gmanetwork.com/news/',
    'enabled',
    'unknown',
    'Official publisher RSS; headline, excerpt, time, and source link only.',
    60,
    'publisher-rss'
  ),
  (
    'abs-cbn-news',
    'ABS-CBN News',
    'https://www.abs-cbn.com/news',
    'enabled',
    'unknown',
    'Publisher feed metadata only; article bodies are not copied.',
    90,
    'publisher-feed'
  ),
  (
    'daily-tribune',
    'Daily Tribune',
    'https://tribune.net.ph/news/',
    'enabled',
    'unknown',
    'Publisher news-sitemap metadata only; author and excerpt may be unavailable.',
    60,
    'publisher-news-sitemap'
  ),
  (
    'manila-times',
    'The Manila Times',
    'https://www.manilatimes.net/news',
    'disabled_pending_permission',
    'disabled',
    'Disabled pending written permission for automated collection.',
    600,
    'disabled-pending-permission'
  ),
  (
    'rappler',
    'Rappler',
    'https://www.rappler.com/latest/',
    'disabled_pending_permission',
    'disabled',
    'Disabled pending written permission for automated aggregation.',
    60,
    'disabled-pending-permission'
  )
ON CONFLICT (source_id) DO UPDATE
SET
  source_name = EXCLUDED.source_name,
  source_home_url = EXCLUDED.source_home_url,
  ingestion_status = EXCLUDED.ingestion_status,
  health_status = CASE
    WHEN EXCLUDED.ingestion_status = 'disabled_pending_permission' THEN 'disabled'
    ELSE public.news_sources.health_status
  END,
  status_detail = EXCLUDED.status_detail,
  poll_interval_seconds = EXCLUDED.poll_interval_seconds,
  transport = EXCLUDED.transport,
  updated_at = statement_timestamp();

CREATE OR REPLACE FUNCTION public.claim_news_source_poll(
  p_source_id text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_source public.news_sources%ROWTYPE;
BEGIN
  SELECT *
  INTO v_source
  FROM public.news_sources AS source
  WHERE source.source_id = p_source_id
  FOR UPDATE;

  IF NOT FOUND OR v_source.ingestion_status <> 'enabled' THEN
    RETURN false;
  END IF;

  IF v_source.last_checked_at IS NOT NULL
     AND v_source.last_checked_at
       > statement_timestamp() - make_interval(secs => v_source.poll_interval_seconds) THEN
    RETURN false;
  END IF;

  UPDATE public.news_sources
  SET
    last_checked_at = statement_timestamp(),
    updated_at = statement_timestamp()
  WHERE source_id = p_source_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_news_source_poll(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_news_source_poll(text)
  TO service_role;

CREATE OR REPLACE FUNCTION private.invoke_news_ingest()
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, extensions, vault, private, pg_temp
AS $$
DECLARE
  v_project_url text;
  v_publishable_key text;
  v_ingest_secret text;
  v_request_id bigint;
BEGIN
  SELECT secret.decrypted_secret
  INTO v_project_url
  FROM vault.decrypted_secrets AS secret
  WHERE secret.name = 'kalasag_project_url'
  ORDER BY secret.created_at DESC
  LIMIT 1;

  SELECT secret.decrypted_secret
  INTO v_publishable_key
  FROM vault.decrypted_secrets AS secret
  WHERE secret.name = 'kalasag_publishable_key'
  ORDER BY secret.created_at DESC
  LIMIT 1;

  SELECT secret.decrypted_secret
  INTO v_ingest_secret
  FROM vault.decrypted_secrets AS secret
  WHERE secret.name = 'kalasag_news_ingest_secret'
  ORDER BY secret.created_at DESC
  LIMIT 1;

  IF nullif(btrim(v_project_url), '') IS NULL
     OR nullif(btrim(v_publishable_key), '') IS NULL
     OR nullif(btrim(v_ingest_secret), '') IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/news-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_publishable_key,
      'Authorization', 'Bearer ' || v_publishable_key,
      'x-kalasag-ingest-secret', v_ingest_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
  INTO v_request_id;

  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION private.invoke_news_ingest()
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid
  INTO v_job_id
  FROM cron.job
  WHERE jobname = 'kalasag-news-ingestion'
  LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;
END;
$$;

SELECT cron.schedule(
  'kalasag-news-ingestion',
  '* * * * *',
  'SELECT private.invoke_news_ingest()'
);

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.news_articles;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;

COMMIT;
