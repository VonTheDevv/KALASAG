BEGIN;

UPDATE public.news_sources
SET
  health_status = 'unknown',
  status_detail = CASE source_id
    WHEN 'inquirer-newsinfo'
      THEN 'Inquirer-only Google News RSS index; headline, time, and redirect link only.'
    WHEN 'manila-standard'
      THEN 'Manila Standard-only Google News RSS index; headline, time, and redirect link only.'
  END,
  transport = 'google-news-rss-index',
  last_checked_at = NULL,
  last_success_at = NULL,
  last_error = NULL,
  item_count = 0,
  etag = NULL,
  last_modified = NULL,
  updated_at = statement_timestamp()
WHERE source_id IN ('inquirer-newsinfo', 'manila-standard');

COMMIT;
