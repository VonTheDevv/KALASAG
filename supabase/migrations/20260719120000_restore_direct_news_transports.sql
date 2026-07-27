-- Use publisher-owned endpoints through the authenticated VPS source relay.
-- The Edge worker can still attempt the same reviewed endpoints directly when
-- the relay is not configured or temporarily unavailable.

update public.news_sources
set
  source_name = 'GMA News',
  source_home_url = 'https://www.gmanetwork.com/news/',
  transport = 'publisher-rss',
  poll_interval_seconds = 60,
  status_detail = 'Official publisher RSS; headline, excerpt, time, and source link only.',
  etag = null,
  last_modified = null,
  last_checked_at = null,
  updated_at = now()
where source_id = 'gma-news';

update public.news_sources
set
  source_name = 'Inquirer NewsInfo',
  source_home_url = 'https://newsinfo.inquirer.net/category/latest-stories',
  transport = 'publisher-rss-via-relay',
  poll_interval_seconds = 60,
  status_detail = 'Official publisher RSS through the bounded server relay; headline, time, and source link only.',
  etag = null,
  last_modified = null,
  last_checked_at = null,
  updated_at = now()
where source_id = 'inquirer-newsinfo';

update public.news_sources
set
  source_name = 'Manila Standard',
  source_home_url = 'https://manilastandard.net/category/news',
  transport = 'publisher-api-via-relay',
  poll_interval_seconds = 60,
  status_detail = 'Official publisher metadata API through the bounded server relay; article bodies are not copied.',
  etag = null,
  last_modified = null,
  last_checked_at = null,
  updated_at = now()
where source_id = 'manila-standard';
