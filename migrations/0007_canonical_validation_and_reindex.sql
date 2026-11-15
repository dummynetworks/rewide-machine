-- Classify rel=canonical metadata without treating it as an HTTP redirect.
-- Existing non-empty values cannot be re-validated from the stored URL alone.
ALTER TABLE documents
  ADD COLUMN canonical_status TEXT NOT NULL DEFAULT 'unverified'
  CHECK (canonical_status IN (
    'missing',
    'self',
    'same-origin',
    'cross-origin',
    'invalid',
    'unverified'
  ));

UPDATE documents
SET canonical_status = 'missing'
WHERE canonical_url IS NULL OR trim(canonical_url) = '';

-- Persist deliberate one-page reindex requests across asynchronous Queue delivery.
ALTER TABLE crawl_jobs
  ADD COLUMN force_reindex INTEGER NOT NULL DEFAULT 0
  CHECK (force_reindex IN (0, 1));
