import test from 'node:test';
import assert from 'node:assert/strict';
import {
  insertCrawlJob,
  getCrawlJob,
  getActiveCrawlJob,
  watchTTL,
  WATCH_TTL_MS,
  updateCrawlJob,
  insertCrawlPage,
  getCrawlPage,
  getCrawlPages,
  saveDocumentAndCompletePage,
  failCrawlPage,
  finalizeCrawlJobIfIdle,
  saveDocumentAndCompleteJob,
  getDocument,
} from '../src/job-store.js';

function createFakeDb() {
  const state = {
    jobs: new Map(),
    pages: new Map(),
    documents: new Map(),
    batches: [],
  };

  const pageKey = (jobId, url) => `${jobId}:${url}`;

  function statement(sql, values = []) {
    return {
      bind(...bound) {
        return statement(sql, bound);
      },
      async run() {
        let changes = 0;

        if (sql.includes('INSERT INTO crawl_jobs')) {
          const [id, url, createdAt, updatedAt, maxPages, maxDepth] = values;
          state.jobs.set(id, {
            id, url, status: 'queued', attempts: 0,
            created_at: createdAt, updated_at: updatedAt,
            max_pages: maxPages, max_depth: maxDepth,
            pages_crawled: 0, pages_failed: 0,
          });
          changes = 1;
        } else if (sql.includes('INSERT OR IGNORE INTO crawl_pages')) {
          const [jobId, url, depth, parentUrl, createdAt, updatedAt] = values;
          const job = state.jobs.get(jobId);
          const key = pageKey(jobId, url);
          const jobPageCount = [...state.pages.values()].filter((page) => page.job_id === jobId).length;
          if (job && !state.pages.has(key) && jobPageCount < job.max_pages) {
            state.pages.set(key, {
              job_id: jobId, url, depth, status: 'queued', attempts: 0,
              parent_url: parentUrl, created_at: createdAt, updated_at: updatedAt,
            });
            changes = 1;
          }
        } else if (sql.includes('UPDATE crawl_pages')) {
          const jobId = values.at(-2);
          const url = values.at(-1);
          const page = state.pages.get(pageKey(jobId, url));
          if (page) {
            if (sql.includes("SET status = 'completed'")) page.status = 'completed';
            if (sql.includes("SET status = 'failed'")) page.status = 'failed';
            const fields = [...sql.matchAll(/([a-z_]+) = \?/g)].map((match) => match[1]);
            fields.forEach((field, index) => { page[field] = values[index]; });
            changes = 1;
          }
        } else if (sql.includes('UPDATE crawl_jobs')) {
          const id = values.at(-1);
          const job = state.jobs.get(id);
          if (job) {
            if (sql.includes('pages_crawled = pages_crawled + 1')) {
              job.pages_crawled += 1;
              job.updated_at = values[0];
            } else if (sql.includes('pages_failed = pages_failed + 1')) {
              job.pages_failed += 1;
              job.updated_at = values[0];
            } else if (sql.includes("SET status = 'completed'")) {
              job.status = 'completed';
              job.updated_at = values[0];
              job.finished_at = values[1];
              job.document_url = values[2];
              job.error_code = null;
              job.error_message = null;
            } else {
              const fields = [...sql.matchAll(/([a-z_]+) = \?/g)].map((match) => match[1]);
              fields.forEach((field, index) => { job[field] = values[index]; });
            }
            changes = 1;
          }
        } else if (sql.includes('INSERT INTO documents')) {
          const [url, fetchedAt, httpStatus, contentType, title, description,
            canonicalUrl, language, text, linksJson, noIndex, noFollow,
            indexable, updatedAt] = values;
          state.documents.set(url, {
            url, fetchedAt, httpStatus, contentType, title, description,
            canonicalUrl, language, text, linksJson, noIndex, noFollow,
            indexable, updatedAt,
          });
          changes = 1;
        }

        return { meta: { changes } };
      },
      async first() {
        if (sql.includes('SUM(CASE WHEN status')) {
          const pages = [...state.pages.values()].filter((page) => page.job_id === values[0]);
          return {
            active: pages.filter((page) => ['queued', 'running'].includes(page.status)).length,
            completed: pages.filter((page) => page.status === 'completed').length,
          };
        }
        if (sql.includes('FROM crawl_jobs') && sql.includes('url = ?')) {
          return [...state.jobs.values()].find((job) => (
            job.url === values[0] && ['queued', 'running'].includes(job.status)
          )) || null;
        }
        if (sql.includes('FROM crawl_jobs')) return state.jobs.get(values[0]) || null;
        if (sql.includes('FROM crawl_pages')) return state.pages.get(pageKey(values[0], values[1])) || null;
        if (sql.includes('FROM documents')) return state.documents.get(values[0]) || null;
        return null;
      },
      async all() {
        const pages = [...state.pages.values()].filter((page) => page.job_id === values[0]);
        if (sql.includes("status = 'queued'")) {
          return {
            results: pages.filter((page) => page.status === 'queued').map((page) => ({
              url: page.url, depth: page.depth, parentUrl: page.parent_url,
            })),
          };
        }
        return { results: pages };
      },
    };
  }

  return {
    state,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      state.batches.push(statements.length);
      for (const item of statements) await item.run();
    },
  };
}

const sampleDocument = {
  url: 'https://example.com/',
  fetchedAt: '2026-11-14T00:00:00.000Z',
  httpStatus: 200,
  contentType: 'text/html',
  title: 'Example',
  description: '',
  canonicalUrl: null,
  language: 'en',
  text: 'Example body',
  links: ['https://example.com/about'],
  noIndex: false,
  noFollow: false,
  indexable: true,
};

test('insert and retrieve a queued crawl job', async () => {
  const db = createFakeDb();
  const job = await insertCrawlJob(db, {
    id: 'job-1',
    url: 'https://example.com/',
    maxPages: 4,
    maxDepth: 2,
    now: '2026-11-14T00:00:00.000Z',
  });

  assert.equal(job.status, 'queued');
  assert.equal((await getCrawlJob(db, 'job-1')).url, 'https://example.com/');
  assert.equal((await getCrawlJob(db, 'job-1')).max_pages, 4);
});

test('watchTTL treats missing documents and documents at least 24 hours old as stale', async () => {
  const db = createFakeDb();
  const now = Date.parse('2026-11-14T12:00:00.000Z');
  const makeDocument = (fetchedAt) => ({
    url: 'https://example.com/',
    fetchedAt,
    httpStatus: 200,
    contentType: 'text/html',
    title: 'Example',
    description: '',
    canonicalUrl: null,
    language: 'en',
    text: 'Example body',
    linksJson: '[]',
    noIndex: 0,
    noFollow: 0,
    indexable: 1,
    updatedAt: fetchedAt,
  });

  assert.equal((await watchTTL(db, 'https://example.com/', { now })).isFresh, false);
  db.state.documents.set('https://example.com/', makeDocument(
    new Date(now - WATCH_TTL_MS + 1).toISOString(),
  ));
  assert.equal((await watchTTL(db, 'https://example.com/', { now })).isFresh, true);
  db.state.documents.set('https://example.com/', makeDocument(
    new Date(now - WATCH_TTL_MS).toISOString(),
  ));
  assert.equal((await watchTTL(db, 'https://example.com/', { now })).isFresh, false);
});

test('finds an already active root crawl by URL', async () => {
  const db = createFakeDb();
  await insertCrawlJob(db, { id: 'active-job', url: 'https://example.com/' });
  assert.equal((await getActiveCrawlJob(db, 'https://example.com/')).id, 'active-job');
});

test('rejects unsupported job update fields', async () => {
  const db = createFakeDb();
  await assert.rejects(
    updateCrawlJob(db, 'job-1', { url: 'https://evil.example/' }),
    /Unsupported crawl job field/,
  );
});

test('frontier deduplicates URLs and enforces the per-job page cap', async () => {
  const db = createFakeDb();
  await insertCrawlJob(db, {
    id: 'job-frontier',
    url: 'https://example.com/',
    maxPages: 2,
    maxDepth: 1,
  });

  assert.equal(await insertCrawlPage(db, {
    jobId: 'job-frontier', url: 'https://example.com/', depth: 0,
  }), true);
  assert.equal(await insertCrawlPage(db, {
    jobId: 'job-frontier', url: 'https://example.com/about', depth: 1,
  }), true);
  assert.equal(await insertCrawlPage(db, {
    jobId: 'job-frontier', url: 'https://example.com/about', depth: 1,
  }), false);
  assert.equal(await insertCrawlPage(db, {
    jobId: 'job-frontier', url: 'https://example.com/contact', depth: 1,
  }), false);

  const pages = await getCrawlPages(db, 'job-frontier');
  assert.equal(pages.length, 2);
  assert.equal((await getCrawlPage(db, 'job-frontier', 'https://example.com/about')).depth, 1);
});

test('stores a page document and completes its frontier row in one D1 batch', async () => {
  const db = createFakeDb();
  await insertCrawlJob(db, { id: 'job-2', url: sampleDocument.url, maxPages: 1 });
  await insertCrawlPage(db, { jobId: 'job-2', url: sampleDocument.url, depth: 0 });

  await saveDocumentAndCompletePage(db, 'job-2', sampleDocument.url, sampleDocument);
  const saved = await getDocument(db, sampleDocument.url);
  const page = await getCrawlPage(db, 'job-2', sampleDocument.url);
  const job = await getCrawlJob(db, 'job-2');

  assert.equal(saved.title, 'Example');
  assert.deepEqual(saved.links, sampleDocument.links);
  assert.equal(page.status, 'completed');
  assert.equal(job.pages_crawled, 1);
  assert.deepEqual(db.state.batches, [3]);
});

test('finalizes an idle crawl job based on successful pages', async () => {
  const db = createFakeDb();
  await insertCrawlJob(db, { id: 'job-3', url: sampleDocument.url });
  await insertCrawlPage(db, { jobId: 'job-3', url: sampleDocument.url, depth: 0 });
  await saveDocumentAndCompletePage(db, 'job-3', sampleDocument.url, sampleDocument);

  assert.equal(await finalizeCrawlJobIfIdle(db, 'job-3'), true);
  assert.equal((await getCrawlJob(db, 'job-3')).status, 'completed');
});

test('stores legacy document completion in one D1 batch', async () => {
  const db = createFakeDb();
  await insertCrawlJob(db, { id: 'job-legacy', url: sampleDocument.url });
  await saveDocumentAndCompleteJob(db, 'job-legacy', sampleDocument, '2026-11-14T00:00:01.000Z');

  const saved = await getDocument(db, sampleDocument.url);
  const job = await getCrawlJob(db, 'job-legacy');

  assert.equal(saved.title, 'Example');
  assert.deepEqual(saved.links, sampleDocument.links);
  assert.equal(job.status, 'completed');
  assert.equal(job.document_url, sampleDocument.url);
  assert.deepEqual(db.state.batches, [2]);
});
