import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const TOKEN = 'test-token-that-is-long-enough-for-worker-auth';

function createDb() {
  const jobs = new Map();

  function makeStatement(sql, values = []) {
    return {
      bind(...bound) {
        return makeStatement(sql, bound);
      },
      async run() {
        if (sql.includes('INSERT INTO crawl_jobs')) {
          const [id, url, createdAt, updatedAt] = values;
          jobs.set(id, {
            id, url, status: 'queued', attempts: 0,
            created_at: createdAt, updated_at: updatedAt,
          });
        }
        if (sql.includes('UPDATE crawl_jobs')) {
          const id = values.at(-1);
          const job = jobs.get(id);
          if (job) {
            const fields = [...sql.matchAll(/([a-z_]+) = \?/g)].map((match) => match[1]);
            fields.forEach((field, index) => { job[field] = values[index]; });
          }
        }
        return { success: true };
      },
      async first() {
        if (sql.includes('FROM crawl_jobs')) return jobs.get(values[0]) || null;
        return null;
      },
    };
  }

  return {
    jobs,
    prepare: (sql) => makeStatement(sql),
    async batch(statements) {
      for (const statement of statements) await statement.run();
    },
  };
}

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

test('POST /v1/crawl persists a job and publishes a queue message', async () => {
  const DB = createDb();
  const sent = [];
  const CRAWL_QUEUE = { async send(body) { sent.push(body); } };
  const response = await worker.fetch(new Request('https://worker.test/v1/crawl', {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  }), { DB, CRAWL_QUEUE, DUMMYNET_TOKEN: TOKEN });

  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.status, 'queued');
  assert.equal(body.url, 'https://example.com/');
  assert.equal(DB.jobs.get(body.jobId).status, 'queued');
  assert.deepEqual(sent, [{ jobId: body.jobId, url: 'https://example.com/' }]);
});

test('GET /v1/jobs/:id returns persisted job state', async () => {
  const DB = createDb();
  const sent = [];
  const CRAWL_QUEUE = { async send(body) { sent.push(body); } };
  const created = await worker.fetch(new Request('https://worker.test/v1/crawl', {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  }), { DB, CRAWL_QUEUE, DUMMYNET_TOKEN: TOKEN });
  const { jobId } = await created.json();

  const response = await worker.fetch(new Request(`https://worker.test/v1/jobs/${jobId}`, {
    headers: authHeaders(),
  }), { DB, CRAWL_QUEUE, DUMMYNET_TOKEN: TOKEN });

  assert.equal(response.status, 200);
  const job = await response.json();
  assert.equal(job.id, jobId);
  assert.equal(job.status, 'queued');
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
});
