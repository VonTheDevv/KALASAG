BEGIN;

-- Rebuild the operational news cache under the strict incident taxonomy.
-- Clearing it also prevents a conditional 304 from preserving records that
-- are no longer allowed by the new filter.
DELETE FROM public.news_articles;

DELETE FROM public.news_sources
WHERE source_id IN ('manila-times', 'rappler');

ALTER TABLE public.news_articles
  DROP CONSTRAINT IF EXISTS news_articles_category_check;

ALTER TABLE public.news_articles
  ALTER COLUMN category SET NOT NULL;

ALTER TABLE public.news_articles
  ADD CONSTRAINT news_articles_category_check
  CHECK (
    category IN (
      'fire',
      'flood',
      'road-incident',
      'killing',
      'robbery-theft',
      'typhoon',
      'earthquake',
      'security-conflict'
    )
  );

ALTER TABLE public.news_articles
  DROP CONSTRAINT IF EXISTS news_articles_hazard_consistency;

ALTER TABLE public.news_articles
  ADD CONSTRAINT news_articles_hazard_consistency
  CHECK (
    is_hazard
    AND incident_expires_at IS NOT NULL
  );

INSERT INTO public.news_sources (
  source_id,
  source_name,
  source_home_url,
  ingestion_status,
  health_status,
  status_detail,
  poll_interval_seconds,
  transport,
  last_checked_at,
  last_success_at,
  last_error,
  item_count,
  etag,
  last_modified
)
VALUES
  (
    'inquirer-newsinfo',
    'Inquirer NewsInfo',
    'https://newsinfo.inquirer.net/category/latest-stories',
    'enabled',
    'unknown',
    'Inquirer-only Google News RSS index; headline, time, and redirect link only.',
    60,
    'google-news-rss-index',
    NULL,
    NULL,
    NULL,
    0,
    NULL,
    NULL
  ),
  (
    'manila-standard',
    'Manila Standard',
    'https://manilastandard.net/category/news',
    'enabled',
    'unknown',
    'Manila Standard-only Google News RSS index; headline, time, and redirect link only.',
    60,
    'google-news-rss-index',
    NULL,
    NULL,
    NULL,
    0,
    NULL,
    NULL
  )
ON CONFLICT (source_id) DO UPDATE
SET
  source_name = EXCLUDED.source_name,
  source_home_url = EXCLUDED.source_home_url,
  ingestion_status = EXCLUDED.ingestion_status,
  health_status = EXCLUDED.health_status,
  status_detail = EXCLUDED.status_detail,
  poll_interval_seconds = EXCLUDED.poll_interval_seconds,
  transport = EXCLUDED.transport,
  last_checked_at = NULL,
  last_success_at = NULL,
  last_error = NULL,
  item_count = 0,
  etag = NULL,
  last_modified = NULL,
  updated_at = statement_timestamp();

-- Force every enabled publisher to perform a full fetch under the new
-- classifier rather than reusing an old conditional-request validator.
UPDATE public.news_sources
SET
  health_status = 'unknown',
  last_checked_at = NULL,
  last_success_at = NULL,
  last_error = NULL,
  item_count = 0,
  etag = NULL,
  last_modified = NULL,
  updated_at = statement_timestamp()
WHERE ingestion_status = 'enabled';

COMMIT;
