CREATE TABLE IF NOT EXISTS crawl_jobs (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  document_url TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_crawl_jobs_status_created
  ON crawl_jobs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS documents (
  url TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  canonical_url TEXT,
  language TEXT,
  text TEXT NOT NULL DEFAULT '',
  links_json TEXT NOT NULL DEFAULT '[]',
  no_index INTEGER NOT NULL DEFAULT 0,
  no_follow INTEGER NOT NULL DEFAULT 0,
  indexable INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_canonical
  ON documents(canonical_url);

CREATE INDEX IF NOT EXISTS idx_documents_fetched_at
  ON documents(fetched_at DESC);
