-- Keep discovered URLs searchable even when their page cannot be crawled.
-- UNKNOWN means noindex has not been observed; it is not equivalent to INDEXABLE.

CREATE TABLE IF NOT EXISTS discovered_urls (
  url TEXT PRIMARY KEY,
  resolved_url TEXT,
  source_url TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('seed', 'link')),
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  anchor_text TEXT NOT NULL DEFAULT '',
  noindex_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (noindex_status IN ('unknown', 'indexable', 'noindex')),
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discovered_urls_status_updated
  ON discovered_urls(noindex_status, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS discovered_urls_fts USING fts5(
  url,
  title,
  description,
  anchor_text,
  content='discovered_urls',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS discovered_urls_fts_ai
AFTER INSERT ON discovered_urls
BEGIN
  INSERT INTO discovered_urls_fts (rowid, url, title, description, anchor_text)
  VALUES (new.rowid, new.url, new.title, new.description, new.anchor_text);
END;

CREATE TRIGGER IF NOT EXISTS discovered_urls_fts_ad
AFTER DELETE ON discovered_urls
BEGIN
  INSERT INTO discovered_urls_fts (
    discovered_urls_fts, rowid, url, title, description, anchor_text
  ) VALUES (
    'delete', old.rowid, old.url, old.title, old.description, old.anchor_text
  );
END;

CREATE TRIGGER IF NOT EXISTS discovered_urls_fts_au
AFTER UPDATE ON discovered_urls
BEGIN
  INSERT INTO discovered_urls_fts (
    discovered_urls_fts, rowid, url, title, description, anchor_text
  ) VALUES (
    'delete', old.rowid, old.url, old.title, old.description, old.anchor_text
  );

  INSERT INTO discovered_urls_fts (rowid, url, title, description, anchor_text)
  VALUES (new.rowid, new.url, new.title, new.description, new.anchor_text);
END;

-- Preserve URLs that were already submitted to the crawl frontier, including failures.
INSERT OR IGNORE INTO discovered_urls (
  url, resolved_url, source_url, source_type, title, description,
  anchor_text, noindex_status, discovered_at, updated_at
)
SELECT
  pages.url,
  NULL,
  pages.parent_url,
  CASE WHEN pages.parent_url IS NULL THEN 'seed' ELSE 'link' END,
  COALESCE(documents.title, ''),
  COALESCE(documents.description, ''),
  '',
  CASE
    WHEN documents.no_index = 1 THEN 'noindex'
    WHEN documents.indexable = 1 THEN 'indexable'
    ELSE 'unknown'
  END,
  pages.created_at,
  pages.updated_at
FROM crawl_pages AS pages
LEFT JOIN documents ON documents.url = pages.url;

-- Also include documents stored under a final redirect URL.
INSERT OR IGNORE INTO discovered_urls (
  url, resolved_url, source_url, source_type, title, description,
  anchor_text, noindex_status, discovered_at, updated_at
)
SELECT
  documents.url,
  NULL,
  NULL,
  'seed',
  documents.title,
  documents.description,
  '',
  CASE WHEN documents.no_index = 1 THEN 'noindex' ELSE 'indexable' END,
  documents.fetched_at,
  documents.updated_at
FROM documents;
