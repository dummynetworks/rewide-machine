import test from 'node:test';
import assert from 'node:assert/strict';
import {
  insertCrawlJob,
  getCrawlJob,
  updateCrawlJob,
  saveDocumentAndCompleteJob,
  getDocument,
} from '../src/job-store.js';

function createFakeDb() {
  const state = { jobs: new Map(), documents: new Map(), batches: [] };

  function statement(sql, values = []) {
    return {
      bind(...bound) {
        return statement(sql, bound);
      },
      async run() {
        if (sql.includes('INSERT INTO crawl_jobs')) {
          const [id, url, , now] = values;
          state.jobs.set(id, {
            id, url, status: 'queued', attempts: 0,
            created_at: now, updated_at: now,
          });
        } else if (sql.includes('UPDATE crawl_jobs')) {
          const id = values.at(-1);
          const job = state.jobs.get(id);
          if (job) {
            if (sql.includes("SET status = 'completed'")) {
              job.status = 'completed';
              job.updated_at = values[0];
              job.finished_at = values[1];
              job.document_url = values[2];
              job.error_code = null;
              job.error_message = null;
            } else {
              const keys = [...sql.matchAll(/([a-z_]+) = \\?/g)].map((match) => match[1]);
              keys.forEach((key, index) => { job[key] = values[index]; });
            }
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
        }
      },
      async first() {
        if (sql.includes('FROM crawl_jobs')) return state.jobs.get(values[0]) || null;
        if (sql.includes('FROM documents')) return state.documents.get(values[0]) || null;
        return null;
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

test('insert and retrieve a queued crawl job', async () => {
  const db = createFakeDb();
  const job = await insertCrawlJob(db, {
    id: 'job-1', url: 'https://example.com/', now: '2026-11-14T00:00:00.000Z',
  });

  assert.equal(job.status, 'queued');
  assert.equal((await getCrawlJob(db, 'job-1')).url, 'https://example.com/');
});

test('rejects unsupported job update fields', async () => {
  const db = createFakeDb();
  await assert.rejects(
    updateCrawlJob(db, 'job-1', { url: 'https://evil.example/' }),
    /Unsupported crawl job field/,
  );
});

test('stores a document and completes its job in one D1 batch', async () => {
  const db = createFakeDb();
  await insertCrawlJob(db, { id: 'job-2', url: 'https://example.com/' });
  const document = {
    url: 'https://example.com/',
    fetchedAt: '2026-11-14T00:00:00.000Z',
    httpStatus: 200,
    contentType: 'text/html',
    title: 'Example',
    description: '',
    canonicalUrl: null,
    language: 'en',
    text: 'Example body',
    links: ['https://www.iana.org/domains/example'],
    noIndex: false,
    noFollow: false,
    indexable: true,
  };

  await saveDocumentAndCompleteJob(db, 'job-2', document, '2026-11-14T00:00:01.000Z');
  const saved = await getDocument(db, document.url);
  const job = await getCrawlJob(db, 'job-2');

  assert.equal(saved.title, 'Example');
  assert.deepEqual(saved.links, document.links);
  assert.equal(saved.indexable, true);
  assert.equal(job.status, 'completed');
  assert.equal(job.document_url, document.url);
  assert.deepEqual(db.state.batches, [2]);
});
