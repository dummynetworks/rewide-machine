import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkerResponse } from '../src/seed-tranco.js';

function response(status, payload, contentType = 'application/json') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

test('classifies a fresh response and retains its full Worker JSON', async () => {
  const payload = {
    url: 'https://example.com/',
    status: 'fresh',
    cached: true,
    crawlRequired: false,
    fetchedAt: '2026-11-15T00:00:00.000Z',
    ttlExpiresAt: '2026-11-16T00:00:00.000Z',
  };

  const result = await classifyWorkerResponse(response(200, payload));

  assert.equal(result.status, 'fresh');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.fetchedAt, payload.fetchedAt);
  assert.deepEqual(result.workerResponse, payload);
});

test('classifies a cooldown response separately and retains retry metadata', async () => {
  const payload = {
    url: 'https://example.com/',
    status: 'cooldown',
    cached: false,
    crawlRequired: false,
    retryAt: '2026-11-16T00:00:00.000Z',
    previousFailureAt: '2026-11-15T00:00:00.000Z',
  };

  const result = await classifyWorkerResponse(response(200, payload));

  assert.equal(result.status, 'cooldown');
  assert.equal(result.retryAt, payload.retryAt);
  assert.equal(result.previousFailureAt, payload.previousFailureAt);
  assert.deepEqual(result.workerResponse, payload);
});

test('classifies newly queued and active deduplicated jobs', async () => {
  const jobId = 'd5b8b33b-ef33-4b39-90aa-e4cd0848a4c4';
  const queuedPayload = {
    jobId,
    url: 'https://example.com/',
    status: 'queued',
    createdAt: '2026-11-15T00:00:00.000Z',
    maxPages: 1,
    maxDepth: 0,
    scope: 'same-origin',
  };
  const deduplicatedPayload = {
    jobId,
    url: 'https://example.com/',
    status: 'running',
    createdAt: '2026-11-15T00:00:00.000Z',
    crawlRequired: false,
    deduplicated: true,
    maxPages: 1,
    maxDepth: 0,
    scope: 'same-origin',
  };

  const queued = await classifyWorkerResponse(response(202, queuedPayload));
  const deduplicated = await classifyWorkerResponse(response(202, deduplicatedPayload));

  assert.equal(queued.status, 'queued');
  assert.equal(queued.jobId, jobId);
  assert.deepEqual(queued.workerResponse, queuedPayload);
  assert.equal(deduplicated.status, 'deduplicated');
  assert.equal(deduplicated.jobId, jobId);
  assert.deepEqual(deduplicated.workerResponse, deduplicatedPayload);
});

const workerErrorCases = [
  {
    code: 'NOT_CONFIGURED',
    httpStatus: 503,
    message: 'DUMMYNET_TOKEN secret is required.',
    category: 'configuration',
    stop: true,
  },
  {
    code: 'UNAUTHORIZED',
    httpStatus: 401,
    category: 'authentication',
    stop: true,
  },
  {
    code: 'ASYNC_CRAWL_NOT_CONFIGURED',
    httpStatus: 503,
    message: 'Bind the D1 database as DB and the Cloudflare Queue as CRAWL_QUEUE before using asynchronous crawling.',
    category: 'configuration',
    stop: true,
  },
  {
    code: 'INVALID_JSON',
    httpStatus: 400,
    category: 'request',
    stop: true,
  },
  {
    code: 'REQUEST_TOO_LARGE',
    httpStatus: 413,
    category: 'request',
    stop: true,
  },
  {
    code: 'INVALID_REQUEST',
    httpStatus: 400,
    message: 'Provide one URL string in the url field.',
    category: 'request',
    stop: true,
  },
  {
    code: 'INVALID_URL',
    httpStatus: 400,
    message: 'Only public HTTP and HTTPS URLs on standard ports are accepted.',
    category: 'url',
    expectedStatus: 'rejected',
    stop: false,
  },
  {
    code: 'DISCOVERY_RECORD_FAILED',
    httpStatus: 503,
    category: 'storage',
    stop: true,
  },
  {
    code: 'WATCH_TTL_FAILED',
    httpStatus: 503,
    message: 'Unable to check the URL crawl history in D1.',
    category: 'storage',
    stop: true,
  },
  {
    code: 'INVALID_CRAWL_LIMITS',
    httpStatus: 400,
    message: 'maxPages must be an integer from 1 to 50; maxDepth must be an integer from 0 to 5.',
    category: 'request',
    stop: true,
  },
  {
    code: 'QUEUE_ENQUEUE_FAILED',
    httpStatus: 503,
    category: 'queue',
    stop: true,
  },
  {
    code: 'METHOD_NOT_ALLOWED',
    httpStatus: 405,
    category: 'endpoint',
    stop: true,
  },
  {
    code: 'NOT_FOUND',
    httpStatus: 404,
    category: 'endpoint',
    stop: true,
  },
];

for (const item of workerErrorCases) {
  test('classifies Worker error JSON: ' + item.code, async () => {
    const payload = { error: item.code };
    if (item.message) payload.message = item.message;

    const result = await classifyWorkerResponse(response(item.httpStatus, payload));

    assert.equal(result.status, item.expectedStatus || 'failed');
    assert.equal(result.httpStatus, item.httpStatus);
    assert.equal(result.category, item.category);
    assert.equal(result.errorCode, item.code);
    assert.equal(result.error, item.code);
    assert.equal(result.errorMessage, item.message || null);
    assert.equal(result.stopSubmission, item.stop);
    assert.deepEqual(result.workerResponse, payload);
  });
}

test('stops instead of repeating an unknown JSON response', async () => {
  const payload = { error: 'NEW_WORKER_ERROR', message: 'The Worker returned a new error code.' };
  const result = await classifyWorkerResponse(response(500, payload));

  assert.equal(result.status, 'failed');
  assert.equal(result.category, 'unknown_worker_error');
  assert.equal(result.errorCode, 'NEW_WORKER_ERROR');
  assert.equal(result.stopSubmission, true);
  assert.deepEqual(result.workerResponse, payload);
});

test('stops on malformed or unrecognized successful responses', async () => {
  const malformed = await classifyWorkerResponse(response(502, 'upstream unavailable', 'text/plain'));
  const unrecognized = await classifyWorkerResponse(response(200, { status: 'unexpected' }));

  assert.equal(malformed.status, 'failed');
  assert.equal(malformed.category, 'invalid_worker_response');
  assert.equal(malformed.stopSubmission, true);
  assert.equal(malformed.workerResponse, null);

  assert.equal(unrecognized.status, 'failed');
  assert.equal(unrecognized.category, 'unknown_worker_error');
  assert.equal(unrecognized.stopSubmission, true);
});
