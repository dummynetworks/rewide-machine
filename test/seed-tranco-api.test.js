import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkerResponse } from '../src/seed-tranco.js';

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('classifies a fresh Worker response', async () => {
  const result = await classifyWorkerResponse(response(200, {
    status: 'fresh',
    fetchedAt: '2026-11-15T00:00:00.000Z',
  }));

  assert.deepEqual(result, {
    status: 'fresh',
    httpStatus: 200,
    fetchedAt: '2026-11-15T00:00:00.000Z',
  });
});

test('classifies a cooldown response separately from a failed request', async () => {
  const result = await classifyWorkerResponse(response(200, {
    status: 'cooldown',
    retryAt: '2026-11-16T00:00:00.000Z',
    previousFailureAt: '2026-11-15T00:00:00.000Z',
  }));

  assert.deepEqual(result, {
    status: 'cooldown',
    httpStatus: 200,
    retryAt: '2026-11-16T00:00:00.000Z',
    previousFailureAt: '2026-11-15T00:00:00.000Z',
  });
});

test('classifies queued and deduplicated submissions', async () => {
  const queued = await classifyWorkerResponse(response(202, {
    status: 'queued',
    jobId: 'd5b8b33b-ef33-4b39-90aa-e4cd0848a4c4',
  }));
  const deduplicated = await classifyWorkerResponse(response(202, {
    status: 'running',
    deduplicated: true,
    jobId: 'd5b8b33b-ef33-4b39-90aa-e4cd0848a4c4',
  }));

  assert.equal(queued.status, 'queued');
  assert.equal(deduplicated.status, 'deduplicated');
});

test('keeps unrecognized Worker responses as failures', async () => {
  const result = await classifyWorkerResponse(response(200, {
    status: 'unexpected',
  }));

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Unexpected Worker response.');
});
