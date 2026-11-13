ALTER TABLE crawl_jobs
  ADD COLUMN max_pages INTEGER NOT NULL DEFAULT 1
  CHECK (max_pages BETWEEN 1 AND 50);

ALTER TABLE crawl_jobs
  ADD COLUMN max_depth INTEGER NOT NULL DEFAULT 0
  CHECK (max_depth BETWEEN 0 AND 5);

ALTER TABLE crawl_jobs
  ADD COLUMN pages_crawled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE crawl_jobs
  ADD COLUMN pages_failed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS crawl_pages (
  job_id TEXT NOT NULL,
  url TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 5),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  parent_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  PRIMARY KEY (job_id, url)
);

CREATE INDEX IF NOT EXISTS idx_crawl_pages_job_status
  ON crawl_pages(job_id, status, depth);
