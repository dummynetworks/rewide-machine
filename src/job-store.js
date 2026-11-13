const JOB_COLUMNS = `
  id, url, status, attempts, created_at, updated_at, finished_at,
  document_url, error_code, error_message, max_pages, max_depth,
  pages_crawled, pages_failed
`;

const PAGE_COLUMNS = `
  job_id, url, depth, status, attempts, parent_url, created_at,
  updated_at, finished_at, error_code, error_message
`;

export async function insertCrawlJob(db, {
  id,
  url,
  maxPages = 1,
  maxDepth = 0,
  now = new Date().toISOString(),
}) {
  await db.prepare(`
    INSERT INTO crawl_jobs (
      id, url, status, attempts, created_at, updated_at, max_pages, max_depth
    ) VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)
  `).bind(id, url, now, now, maxPages, maxDepth).run();

  return {
    id,
    url,
    status: 'queued',
    attempts: 0,
    created_at: now,
    updated_at: now,
    max_pages: maxPages,
    max_depth: maxDepth,
    pages_crawled: 0,
    pages_failed: 0,
  };
}

export async function getCrawlJob(db, id) {
  return db.prepare(`
    SELECT ${JOB_COLUMNS} FROM crawl_jobs WHERE id = ? LIMIT 1
  `).bind(id).first();
}

export async function updateCrawlJob(db, id, fields) {
  const assignments = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    if (!['status', 'attempts', 'updated_at', 'finished_at', 'document_url', 'error_code', 'error_message'].includes(key)) {
      throw new TypeError(`Unsupported crawl job field: ${key}`);
    }
    assignments.push(`${key} = ?`);
    values.push(value);
  }

  if (assignments.length === 0) return;
  values.push(id);
  await db.prepare(`
    UPDATE crawl_jobs SET ${assignments.join(', ')} WHERE id = ?
  `).bind(...values).run();
}

export async function insertCrawlPage(db, {
  jobId,
  url,
  depth,
  parentUrl = null,
  now = new Date().toISOString(),
}) {
  const result = await db.prepare(`
    INSERT OR IGNORE INTO crawl_pages (
      job_id, url, depth, status, attempts, parent_url, created_at, updated_at
    )
    SELECT ?, ?, ?, 'queued', 0, ?, ?, ?
    WHERE (
      SELECT COUNT(*) FROM crawl_pages WHERE job_id = ?
    ) < (
      SELECT max_pages FROM crawl_jobs WHERE id = ?
    )
  `).bind(jobId, url, depth, parentUrl, now, now, jobId, jobId).run();

  return Number(result?.meta?.changes || 0) > 0;
}

export async function getCrawlPage(db, jobId, url) {
  return db.prepare(`
    SELECT ${PAGE_COLUMNS}
    FROM crawl_pages
    WHERE job_id = ? AND url = ?
    LIMIT 1
  `).bind(jobId, url).first();
}

export async function getCrawlPages(db, jobId) {
  const result = await db.prepare(`
    SELECT ${PAGE_COLUMNS}
    FROM crawl_pages
    WHERE job_id = ?
    ORDER BY depth ASC, created_at ASC
  `).bind(jobId).all();

  return result?.results || [];
}

export async function listQueuedCrawlPages(db, jobId) {
  const result = await db.prepare(`
    SELECT url, depth, parent_url AS parentUrl
    FROM crawl_pages
    WHERE job_id = ? AND status = 'queued'
    ORDER BY depth ASC, created_at ASC
  `).bind(jobId).all();

  return result?.results || [];
}

export async function updateCrawlPage(db, jobId, url, fields) {
  const assignments = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    if (!['status', 'attempts', 'updated_at', 'finished_at', 'error_code', 'error_message'].includes(key)) {
      throw new TypeError(`Unsupported crawl page field: ${key}`);
    }
    assignments.push(`${key} = ?`);
    values.push(value);
  }

  if (assignments.length === 0) return;
  values.push(jobId, url);
  await db.prepare(`
    UPDATE crawl_pages SET ${assignments.join(', ')}
    WHERE job_id = ? AND url = ?
  `).bind(...values).run();
}

export async function saveDocumentAndCompletePage(
  db,
  jobId,
  pageUrl,
  document,
  now = new Date().toISOString(),
) {
  const documentStatement = db.prepare(`
    INSERT INTO documents (
      url, fetched_at, http_status, content_type, title, description,
      canonical_url, language, text, links_json, no_index, no_follow,
      indexable, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      fetched_at = excluded.fetched_at,
      http_status = excluded.http_status,
      content_type = excluded.content_type,
      title = excluded.title,
      description = excluded.description,
      canonical_url = excluded.canonical_url,
      language = excluded.language,
      text = excluded.text,
      links_json = excluded.links_json,
      no_index = excluded.no_index,
      no_follow = excluded.no_follow,
      indexable = excluded.indexable,
      updated_at = excluded.updated_at
  `).bind(
    document.url,
    document.fetchedAt,
    document.httpStatus,
    document.contentType,
    document.title,
    document.description,
    document.canonicalUrl,
    document.language,
    document.text,
    JSON.stringify(document.links),
    document.noIndex ? 1 : 0,
    document.noFollow ? 1 : 0,
    document.indexable ? 1 : 0,
    now,
  );

  const pageStatement = db.prepare(`
    UPDATE crawl_pages
    SET status = 'completed',
        updated_at = ?,
        finished_at = ?,
        error_code = NULL,
        error_message = NULL
    WHERE job_id = ? AND url = ?
  `).bind(now, now, jobId, pageUrl);

  const jobStatement = db.prepare(`
    UPDATE crawl_jobs
    SET pages_crawled = pages_crawled + 1,
        status = 'running',
        updated_at = ?
    WHERE id = ?
  `).bind(now, jobId);

  await db.batch([documentStatement, pageStatement, jobStatement]);
}

export async function failCrawlPage(db, jobId, url, {
  attempts,
  errorCode,
  errorMessage,
  now = new Date().toISOString(),
}) {
  const pageStatement = db.prepare(`
    UPDATE crawl_pages
    SET status = 'failed',
        attempts = ?,
        updated_at = ?,
        finished_at = ?,
        error_code = ?,
        error_message = ?
    WHERE job_id = ? AND url = ?
  `).bind(attempts, now, now, errorCode, errorMessage, jobId, url);

  const jobStatement = db.prepare(`
    UPDATE crawl_jobs
    SET pages_failed = pages_failed + 1,
        updated_at = ?
    WHERE id = ?
  `).bind(now, jobId);

  await db.batch([pageStatement, jobStatement]);
}

export async function finalizeCrawlJobIfIdle(db, jobId, now = new Date().toISOString()) {
  const counts = await db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
    FROM crawl_pages
    WHERE job_id = ?
  `).bind(jobId).first();

  if (!counts || Number(counts.active || 0) > 0) return false;

  const status = Number(counts.completed || 0) > 0 ? 'completed' : 'failed';
  await db.prepare(`
    UPDATE crawl_jobs
    SET status = ?,
        updated_at = ?,
        finished_at = ?
    WHERE id = ? AND status NOT IN ('completed', 'failed')
  `).bind(status, now, now, jobId).run();

  return true;
}

export async function saveDocumentAndCompleteJob(db, jobId, document, now = new Date().toISOString()) {
  const documentStatement = db.prepare(`
    INSERT INTO documents (
      url, fetched_at, http_status, content_type, title, description,
      canonical_url, language, text, links_json, no_index, no_follow,
      indexable, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      fetched_at = excluded.fetched_at,
      http_status = excluded.http_status,
      content_type = excluded.content_type,
      title = excluded.title,
      description = excluded.description,
      canonical_url = excluded.canonical_url,
      language = excluded.language,
      text = excluded.text,
      links_json = excluded.links_json,
      no_index = excluded.no_index,
      no_follow = excluded.no_follow,
      indexable = excluded.indexable,
      updated_at = excluded.updated_at
  `).bind(
    document.url,
    document.fetchedAt,
    document.httpStatus,
    document.contentType,
    document.title,
    document.description,
    document.canonicalUrl,
    document.language,
    document.text,
    JSON.stringify(document.links),
    document.noIndex ? 1 : 0,
    document.noFollow ? 1 : 0,
    document.indexable ? 1 : 0,
    now,
  );

  const jobStatement = db.prepare(`
    UPDATE crawl_jobs
    SET status = 'completed',
        updated_at = ?,
        finished_at = ?,
        document_url = ?,
        error_code = NULL,
        error_message = NULL
    WHERE id = ?
  `).bind(now, now, document.url, jobId);

  await db.batch([documentStatement, jobStatement]);
}

export async function getDocument(db, url) {
  const row = await db.prepare(`
    SELECT url, fetched_at AS fetchedAt, http_status AS httpStatus,
      content_type AS contentType, title, description,
      canonical_url AS canonicalUrl, language, text, links_json AS linksJson,
      no_index AS noIndex, no_follow AS noFollow, indexable, updated_at AS updatedAt
    FROM documents WHERE url = ? LIMIT 1
  `).bind(url).first();

  if (!row) return null;
  let links = [];
  try {
    links = JSON.parse(row.linksJson || '[]');
  } catch {
    links = [];
  }

  return {
    ...row,
    links,
    noIndex: Boolean(row.noIndex),
    noFollow: Boolean(row.noFollow),
    indexable: Boolean(row.indexable),
  };
}
