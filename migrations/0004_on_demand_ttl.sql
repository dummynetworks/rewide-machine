-- Rewide on-demand crawling policy: cache successful documents for 24 hours
-- and prevent multiple active root jobs for the same normalized URL.

ALTER TABLE crawl_jobs
  ADD COLUMN pages_skipped INTEGER NOT NULL DEFAULT 0;

ALTER TABLE crawl_pages
  ADD COLUMN skip_reason TEXT;

-- Resolve any pre-existing duplicate active root jobs before enforcing uniqueness.
WITH ranked_active_jobs AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY url
      ORDER BY created_at ASC, id ASC
    ) AS position
  FROM crawl_jobs
  WHERE status IN ('queued', 'running')
)
UPDATE crawl_jobs
SET
  status = 'failed',
  updated_at = CURRENT_TIMESTAMP,
  finished_at = CURRENT_TIMESTAMP,
  error_code = 'SUPERSEDED_DUPLICATE_JOB',
  error_message = 'Superseded by an earlier active crawl for the same URL.'
WHERE id IN (
  SELECT id
  FROM ranked_active_jobs
  WHERE position > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crawl_jobs_one_active_root_per_url
  ON crawl_jobs(url)
  WHERE status IN ('queued', 'running');
