BEGIN;

-- Maritime incidents must use explicit publisher-reported offshore coordinates;
-- this precision value keeps them distinct from a locality or province centroid.
ALTER TABLE public.news_articles
  DROP CONSTRAINT IF EXISTS news_articles_location_precision_check;

ALTER TABLE public.news_articles
  ADD CONSTRAINT news_articles_location_precision_check
  CHECK (
    location_precision IS NULL
    OR location_precision IN ('street', 'locality', 'region', 'offshore')
  );

COMMIT;
