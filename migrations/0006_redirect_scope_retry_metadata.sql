-- Persist the final crawl scope after a permitted root redirect and retain
-- upstream HTTP retry metadata for per-error retry scheduling.

ALTER TABLE crawl_jobs
  ADD COLUMN scope_origin TEXT;

ALTER TABLE crawl_pages
  ADD COLUMN upstream_http_status INTEGER;

ALTER TABLE crawl_pages
  ADD COLUMN retry_after_at TEXT;
