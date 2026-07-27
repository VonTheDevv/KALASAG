-- A transport change is not healthy until the new path has completed a real
-- publisher fetch. Clear operational state left by the replaced transport so
-- clients cannot briefly display it as current.

update public.news_sources
set
  health_status = 'unknown',
  last_success_at = null,
  last_error = null,
  item_count = 0,
  etag = null,
  last_modified = null,
  last_checked_at = null,
  updated_at = now()
where source_id in (
  'gma-news',
  'inquirer-newsinfo',
  'manila-standard'
);
