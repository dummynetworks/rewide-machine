const JOB_COLUMNS = `
  id, url, status, attempts, created_at, updated_at, finished_at,
  document_url, error_code, error_message
`;

export async function insertCrawlJob(db, { id, url, now = new Date().toISOString() }) {
  await db.prepare(`
    INSERT INTO crawl_jobs (id, url, status, attempts, created_at, updated_at)
    VALUES (?, ?, 'queued', 0, ?, ?)
  `).bind(id, url, now, now).run();

  return { id, url, status: 'queued', attempts: 0, created_at: now, updated_at: now };
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
