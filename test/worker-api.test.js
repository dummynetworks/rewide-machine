import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const TOKEN = 'test-token-that-is-long-enough-for-worker-auth';

function createDb() {
  const jobs = new Map();
  const pages = new Map();
  const documents = new Map();
  const pageKey = (jobId, url) => `${jobId}:${url}`;

  function makeStatement(sql, values = []) {
    return {
      bind(...bound) {
        return makeStatement(sql, bound);
      },
      async run() {
        let changes = 0;

        if (sql.includes('INSERT INTO crawl_jobs')) {
          const [id, url, createdAt, updatedAt, maxPages, maxDepth] = values;
          jobs.set(id, {
            id, url, status: 'queued', attempts: 0,
            created_at: createdAt, updated_at: updatedAt,
            max_pages: maxPages, max_depth: maxDepth,
            pages_crawled: 0, pages_failed: 0, pages_skipped: 0,
          });
          changes = 1;
        } else if (sql.includes('INSERT OR IGNORE INTO crawl_pages')) {
          const [jobId, url, depth, parentUrl, createdAt, updatedAt] = values;
          const job = jobs.get(jobId);
          const count = [...pages.values()].filter((page) => page.job_id === jobId).length;
          const key = pageKey(jobId, url);
          if (job && !pages.has(key) && count < job.max_pages) {
            pages.set(key, {
              job_id: jobId, url, depth, status: 'queued',
              attempts: 0, parent_url: parentUrl,
              created_at: createdAt, updated_at: updatedAt,
            });
            changes = 1;
          }
        } else if (sql.includes('UPDATE crawl_jobs')) {
          const id = values.at(-1);
          const job = jobs.get(id);
          if (job) {
            if (sql.includes('pages_crawled = pages_crawled + 1')) {
              job.pages_crawled += 1;
              job.updated_at = values[0];
            } else if (sql.includes('pages_failed = pages_failed + 1')) {
              job.pages_failed += 1;
              job.updated_at = values[0];
            } else {
              const fields = [...sql.matchAll(/([a-z_]+) = \?/g)].map((match) => match[1]);
              fields.forEach((field, index) => { job[field] = values[index]; });
            }
            changes = 1;
          }
        }

        return { meta: { changes } };
      },
      async first() {
        if (sql.includes('FROM documents')) return documents.get(values[0]) || null;
        if (sql.includes('FROM crawl_jobs') && sql.includes('url = ?')) {
          return [...jobs.values()].find((job) => (
            job.url === values[0] && ['queued', 'running'].includes(job.status)
          )) || null;
        }
        if (sql.includes('FROM crawl_jobs')) return jobs.get(values[0]) || null;
        if (sql.includes('FROM crawl_pages')) return pages.get(pageKey(values[0], values[1])) || null;
        return null;
      },
      async all() {
        return {
          results: [...pages.values()].filter((page) => page.job_id === values[0]),
        };
      },
    };
  }

  return {
    jobs,
    pages,
    documents,
    prepare: (sql) => makeStatement(sql),
    async batch(statements) {
      for (const statement of statements) await statement.run();
    },
  };
}

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

async function submitCrawl({ DB, CRAWL_QUEUE, payload }) {
  return worker.fetch(new Request('https://worker.test/v1/crawl', {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }), { DB, CRAWL_QUEUE, DUMMYNET_TOKEN: TOKEN });
}

test('POST /v1/crawl persists a root page and publishes a queue message', async () => {
  const DB = createDb();
  const sent = [];
  const CRAWL_QUEUE = { async send(body) { sent.push(body); } };
  const response = await submitCrawl({
    DB,
    CRAWL_QUEUE,
    payload: { url: 'https://example.com/' },
  });

  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.status, 'queued');
  assert.equal(body.url, 'https://example.com/');
  assert.equal(body.maxPages, 1);
  assert.equal(body.maxDepth, 0);
  assert.equal(DB.jobs.get(body.jobId).status, 'queued');
  assert.equal(DB.pages.size, 1);
  assert.deepEqual(sent, [{
    jobId: body.jobId,
    url: 'https://example.com/',
    depth: 0,
    parentUrl: null,
  }]);
});

test('POST /v1/crawl returns a fresh document without enqueueing another crawl', async () => {
  const DB = createDb();
  const sent = [];
  const url = 'https://example.com/';
  DB.documents.set(url, {
    url,
    fetchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    httpStatus: 200,
    contentType: 'text/html',
    title: 'Cached Example',
    description: '',
    canonicalUrl: null,
    language: 'en',
    text: 'cached',
    linksJson: '[]',
    noIndex: 0,
    noFollow: 0,
    indexable: 1,
    updatedAt: new Date().toISOString(),
  });
  const CRAWL_QUEUE = { async send(body) { sent.push(body); } };

  const response = await submitCrawl({ DB, CRAWL_QUEUE, payload: { url } });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'fresh');
  assert.equal(body.cached, true);
  assert.equal(body.crawlRequired, false);
  assert.equal(DB.jobs.size, 0);
  assert.deepEqual(sent, []);
});

test('POST /v1/crawl reuses an already active job for the same URL', async () => {
  const DB = createDb();
  const sent = [];
  const activeJob = {
    id: '00000000-0000-4000-8000-000000000001',
    url: 'https://example.com/',
    status: 'running',
    created_at: new Date().toISOString(),
    max_pages: 10,
    max_depth: 1,
  };
  DB.jobs.set(activeJob.id, activeJob);
  const CRAWL_QUEUE = { async send(body) { sent.push(body); } };

  const response = await submitCrawl({
    DB, CRAWL_QUEUE, payload: { url: activeJob.url },
  });
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(body.jobId, activeJob.id);
  assert.equal(body.deduplicated, true);
  assert.equal(DB.jobs.size, 1);
  assert.deepEqual(sent, []);
});

test('POST /v1/crawl accepts bounded recursive crawl limits', async () => {
  const DB = createDb();
  const sent = [];
  const CRAWL_QUEUE = { async send(body) { sent.push(body); } };
  const response = await submitCrawl({
    DB,
    CRAWL_QUEUE,
    payload: { url: 'https://example.com/', maxPages: 12, maxDepth: 3 },
  });

  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.maxPages, 12);
  assert.equal(body.maxDepth, 3);
  assert.equal(body.scope, 'same-origin');
  assert.equal(DB.jobs.get(body.jobId).max_pages, 12);
  assert.equal(DB.jobs.get(body.jobId).max_depth, 3);
});

test('POST /v1/crawl rejects unsafe or invalid crawl limits', async () => {
  const DB = createDb();
  const CRAWL_QUEUE = { async send() {} };
  const response = await submitCrawl({
    DB,
    CRAWL_QUEUE,
    payload: { url: 'https://example.com/', maxPages: 51, maxDepth: 2 },
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'INVALID_CRAWL_LIMITS');
});

test('GET /v1/jobs/:id returns persisted job state', async () => {
  const DB = createDb();
  const sent = [];
  const CRAWL_QUEUE = { async send(body) { sent.push(body); } };
  const created = await submitCrawl({
    DB, CRAWL_QUEUE, payload: { url: 'https://example.com/' },
  });
  const { jobId } = await created.json();

  const response = await worker.fetch(new Request(`https://worker.test/v1/jobs/${jobId}`, {
    headers: authHeaders(),
  }), { DB, CRAWL_QUEUE, DUMMYNET_TOKEN: TOKEN });

  assert.equal(response.status, 200);
  const job = await response.json();
  assert.equal(job.id, jobId);
  assert.equal(job.status, 'queued');
  assert.equal(job.max_pages, 1);
});

test('GET /v1/jobs/:id/pages lists the crawl frontier', async () => {
  const DB = createDb();
  const CRAWL_QUEUE = { async send() {} };
  const created = await submitCrawl({
    DB, CRAWL_QUEUE, payload: { url: 'https://example.com/', maxPages: 3 },
  });
  const { jobId } = await created.json();

  const response = await worker.fetch(new Request(
    `https://worker.test/v1/jobs/${jobId}/pages`,
    { headers: authHeaders() },
  ), { DB, CRAWL_QUEUE, DUMMYNET_TOKEN: TOKEN });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.pages[0].depth, 0);
});

test('POST /v1/crawl reports missing Queue or D1 bindings', async () => {
  const response = await worker.fetch(new Request('https://worker.test/v1/crawl', {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  }), { DUMMYNET_TOKEN: TOKEN });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'ASYNC_CRAWL_NOT_CONFIGURED');
});

test('health endpoint reports whether async resources are bound', async () => {
  const response = await worker.fetch(new Request('https://worker.test/health'), {});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.capabilities.asyncCrawl, false);
  assert.equal(body.capabilities.recursiveCrawl, true);
});
