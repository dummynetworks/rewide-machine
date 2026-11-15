import { calculateFailureRetryAt } from './retry-policy.js';

const JOB_COLUMNS = `
  id, url, status, attempts, created_at, updated_at, finished_at,
  document_url, error_code, error_message, max_pages, max_depth,
  pages_crawled, pages_failed, pages_skipped, scope_origin
`;

const PAGE_COLUMNS = `
  job_id, url, depth, status, attempts, parent_url, created_at,
  updated_at, finished_at, error_code, error_message, skip_reason,
  upstream_http_status, retry_after_at
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
      id, url, status, attempts, created_at, updated_at, max_pages, max_depth, scope_origin
    ) VALUES (?, ?, 'queued', 0, ?, ?, ?, ?, ?)
  `).bind(id, url, now, now, maxPages, maxDepth, new URL(url).origin).run();

  return {
    id,
    url,
    status: 'queued',
    attempts: 0,
    created_at: now,
    updated_at: now,
    max_pages: maxPages,
    max_depth: maxDepth,
    scope_origin: new URL(url).origin,
    pages_crawled: 0,
    pages_failed: 0,
  };
}

export async function getCrawlJob(db, id) {
  return db.prepare(`
    SELECT ${JOB_COLUMNS} FROM crawl_jobs WHERE id = ? LIMIT 1
  `).bind(id).first();
}

export async function getActiveCrawlJob(db, url) {
  return db.prepare(`
    SELECT ${JOB_COLUMNS}
    FROM crawl_jobs
    WHERE url = ? AND status IN ('queued', 'running')
    ORDER BY created_at ASC
    LIMIT 1
  `).bind(url).first();
}

// Legacy constant retained for callers that explicitly need the original
// 24-hour policy. New cooldowns are selected from the recorded failure reason.
export const FAILED_CRAWL_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * Apply per-error retry timing to a failed root job. The success watchTTL is
 * independent and is never refreshed by these failure records.
 */
export async function getRecentFailedCrawlJob(db, url, {
  now = Date.now(),
  retryMs,
} = {}) {
  const job = await db.prepare(`
    SELECT
      j.id,
      j.finished_at AS finishedAt,
      p.error_code AS errorCode,
      p.upstream_http_status AS upstreamHttpStatus,
      p.retry_after_at AS retryAfterAt
    FROM crawl_jobs AS j
    LEFT JOIN crawl_pages AS p
      ON p.job_id = j.id AND p.url = j.url AND p.depth = 0
    WHERE j.url = ? AND j.status = 'failed' AND j.finished_at IS NOT NULL
    ORDER BY j.finished_at DESC
    LIMIT 1
  `).bind(url).first();

  if (!job?.finishedAt) return null;

  const retryAt = calculateFailureRetryAt({
    failedAt: job.finishedAt,
    errorCode: job.errorCode,
    upstreamHttpStatus: job.upstreamHttpStatus,
    retryAfterAt: job.retryAfterAt,
    retryMs,
  });
  const retryAtMs = Date.parse(retryAt || '');
  if (!Number.isFinite(retryAtMs) || retryAtMs <= now) return null;

  return {
    id: job.id,
    failedAt: job.finishedAt,
    errorCode: job.errorCode || null,
    upstreamHttpStatus: job.upstreamHttpStatus ?? null,
    retryAt,
    remainingMs: Math.max(0, retryAtMs - now),
  };
}

export async function updateCrawlJob(db, id, fields) {
  const assignments = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    if (!['status', 'attempts', 'updated_at', 'finished_at', 'document_url', 'error_code', 'error_message', 'scope_origin'].includes(key)) {
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

export async function upsertDiscoveredUrl(db, {
  url,
  sourceUrl = null,
  sourceType = 'seed',
  anchorText = '',
  now = new Date().toISOString(),
}) {
  if (typeof url !== 'string' || url.length > 2_048) {
    throw new TypeError('A normalized URL is required for discovery storage.');
  }
  if (!['seed', 'link'].includes(sourceType)) {
    throw new TypeError('Unsupported discovery source type.');
  }

  const safeSourceUrl = typeof sourceUrl === 'string' && sourceUrl.length <= 2_048
    ? sourceUrl
    : null;
  const safeAnchorText = typeof anchorText === 'string'
    ? anchorText.replace(/\s+/g, ' ').trim().slice(0, 2_000)
    : '';

  await db.prepare(`
    INSERT INTO discovered_urls (
      url, resolved_url, source_url, source_type, title, description,
      anchor_text, noindex_status, discovered_at, updated_at
    ) VALUES (?, NULL, ?, ?, '', '', ?, 'unknown', ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      source_url = COALESCE(discovered_urls.source_url, excluded.source_url),
      source_type = CASE
        WHEN discovered_urls.source_type = 'seed' THEN 'seed'
        ELSE excluded.source_type
      END,
      anchor_text = CASE
        WHEN excluded.anchor_text = '' THEN discovered_urls.anchor_text
        WHEN discovered_urls.anchor_text = '' THEN substr(excluded.anchor_text, 1, 2_000)
        WHEN instr(discovered_urls.anchor_text, excluded.anchor_text) > 0
          THEN discovered_urls.anchor_text
        ELSE substr(discovered_urls.anchor_text || ' ' || excluded.anchor_text, 1, 2_000)
      END,
      updated_at = excluded.updated_at
  `).bind(url, safeSourceUrl, sourceType, safeAnchorText, now, now).run();
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
    if (!['status', 'attempts', 'updated_at', 'finished_at', 'error_code', 'error_message', 'skip_reason', 'upstream_http_status', 'retry_after_at'].includes(key)) {
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
  scopeOrigin = null,
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
        skip_reason = NULL,
        error_code = NULL,
        error_message = NULL
    WHERE job_id = ? AND url = ?
  `).bind(now, now, jobId, pageUrl);

  const jobStatement = db.prepare(`
    UPDATE crawl_jobs
    SET pages_crawled = pages_crawled + 1,
        status = 'running',
        updated_at = ?,
        scope_origin = COALESCE(?, scope_origin)
    WHERE id = ?
  `).bind(now, scopeOrigin, jobId);

  const discoveryStatement = db.prepare(`
    INSERT INTO discovered_urls (
      url, resolved_url, source_url, source_type, title, description,
      anchor_text, noindex_status, discovered_at, updated_at
    ) VALUES (?, ?, NULL, 'seed', ?, ?, '', ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      resolved_url = excluded.resolved_url,
      title = excluded.title,
      description = excluded.description,
      noindex_status = excluded.noindex_status,
      updated_at = excluded.updated_at
  `).bind(
    pageUrl,
    document.url !== pageUrl ? document.url : null,
    document.title || '',
    document.description || '',
    document.noIndex ? 'noindex' : 'indexable',
    document.fetchedAt || now,
    now,
  );

  await db.batch([documentStatement, pageStatement, jobStatement, discoveryStatement]);
}

export async function completeCrawlPageAsSkipped(
  db,
  jobId,
  pageUrl,
  reason = 'fresh-within-watch-ttl',
  now = new Date().toISOString(),
) {
  const pageStatement = db.prepare(`
    UPDATE crawl_pages
    SET status = 'completed',
        updated_at = ?,
        finished_at = ?,
        skip_reason = ?,
        error_code = NULL,
        error_message = NULL
    WHERE job_id = ? AND url = ?
  `).bind(now, now, reason, jobId, pageUrl);

  const jobStatement = db.prepare(`
    UPDATE crawl_jobs
    SET pages_skipped = pages_skipped + 1,
        status = 'running',
        updated_at = ?
    WHERE id = ?
  `).bind(now, jobId);

  await db.batch([pageStatement, jobStatement]);
}

export async function failCrawlPage(db, jobId, url, {
  attempts,
  errorCode,
  errorMessage,
  upstreamHttpStatus = null,
  retryAfterAt = null,
  now = new Date().toISOString(),
}) {
  const pageStatement = db.prepare(`
    UPDATE crawl_pages
    SET status = 'failed',
        attempts = ?,
        updated_at = ?,
        finished_at = ?,
        error_code = ?,
        error_message = ?,
        upstream_http_status = ?,
        retry_after_at = ?
    WHERE job_id = ? AND url = ?
  `).bind(
    attempts, now, now, errorCode, errorMessage,
    upstreamHttpStatus, retryAfterAt, jobId, url,
  );

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

  const discoveryStatement = db.prepare(`
    INSERT INTO discovered_urls (
      url, resolved_url, source_url, source_type, title, description,
      anchor_text, noindex_status, discovered_at, updated_at
    ) VALUES (?, NULL, NULL, 'seed', ?, ?, '', ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      noindex_status = excluded.noindex_status,
      updated_at = excluded.updated_at
  `).bind(
    document.url,
    document.title || '',
    document.description || '',
    document.noIndex ? 'noindex' : 'indexable',
    document.fetchedAt || now,
    now,
  );

  await db.batch([documentStatement, jobStatement, discoveryStatement]);
}

export const WATCH_TTL_MS = 24 * 60 * 60 * 1000;

export async function watchTTL(db, url, {
  now = Date.now(),
  ttlMs = WATCH_TTL_MS,
} = {}) {
  let document = await getDocument(db, url);
  if (!document) {
    const discovery = await db.prepare(`
      SELECT resolved_url AS resolvedUrl
      FROM discovered_urls
      WHERE url = ? AND resolved_url IS NOT NULL
      LIMIT 1
    `).bind(url).first();
    if (discovery?.resolvedUrl) document = await getDocument(db, discovery.resolvedUrl);
  }
  const fetchedAtMs = Date.parse(document?.fetchedAt ?? '');

  if (!document || !Number.isFinite(fetchedAtMs)) {
    return {
      isFresh: false,
      document: document ?? null,
      fetchedAt: document?.fetchedAt ?? null,
      ageMs: null,
      expiresAt: null,
    };
  }

  const ageMs = now - fetchedAtMs;
  return {
    isFresh: ageMs < ttlMs,
    document,
    fetchedAt: document.fetchedAt,
    ageMs: Math.max(0, ageMs),
    expiresAt: new Date(fetchedAtMs + ttlMs).toISOString(),
  };
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
