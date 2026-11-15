import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROBOTS_DISALLOWED_RETRY_MS,
  CROSS_ORIGIN_REDIRECT_RETRY_MS,
  UPSTREAM_TRANSIENT_RETRY_MS,
  UPSTREAM_RATE_LIMIT_RETRY_MS,
  UPSTREAM_CLIENT_ERROR_RETRY_MS,
  getFailureRetryDelayMs,
  parseRetryAfterAt,
  calculateFailureRetryAt,
} from '../src/retry-policy.js';

test('keeps robots disallow and out-of-scope redirects on a daily retry window', () => {
  assert.equal(getFailureRetryDelayMs('ROBOTS_DISALLOWED'), ROBOTS_DISALLOWED_RETRY_MS);
  assert.equal(getFailureRetryDelayMs('CROSS_ORIGIN_REDIRECT'), CROSS_ORIGIN_REDIRECT_RETRY_MS);
});

test('uses shorter retries for transient upstream HTTP statuses', () => {
  assert.equal(getFailureRetryDelayMs('UPSTREAM_HTTP_ERROR', 408), UPSTREAM_TRANSIENT_RETRY_MS);
  assert.equal(getFailureRetryDelayMs('UPSTREAM_HTTP_ERROR', 425), UPSTREAM_TRANSIENT_RETRY_MS);
  assert.equal(getFailureRetryDelayMs('UPSTREAM_HTTP_ERROR', 503), UPSTREAM_TRANSIENT_RETRY_MS);
  assert.equal(getFailureRetryDelayMs('UPSTREAM_HTTP_ERROR', 429), UPSTREAM_RATE_LIMIT_RETRY_MS);
  assert.equal(getFailureRetryDelayMs('UPSTREAM_HTTP_ERROR', 404), UPSTREAM_CLIENT_ERROR_RETRY_MS);
});

test('uses short retries for exhausted temporary Worker attempts', () => {
  assert.equal(getFailureRetryDelayMs('RETRY_LIMIT_EXCEEDED'), UPSTREAM_TRANSIENT_RETRY_MS);
  assert.equal(getFailureRetryDelayMs('ROBOTS_FETCH_TEMPORARY_FAILURE'), UPSTREAM_TRANSIENT_RETRY_MS);
});

test('parses both delta-seconds and HTTP-date Retry-After values', () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  assert.equal(
    parseRetryAfterAt('120', now),
    '2026-11-15T00:02:00.000Z',
  );
  assert.equal(
    parseRetryAfterAt('Sun, 15 Nov 2026 01:00:00 GMT', now),
    '2026-11-15T01:00:00.000Z',
  );
  assert.equal(parseRetryAfterAt('not-a-date', now), null);
});

test('never schedules before the policy delay, even when Retry-After is shorter', () => {
  const retryAt = calculateFailureRetryAt({
    failedAt: '2026-11-15T00:00:00.000Z',
    errorCode: 'UPSTREAM_HTTP_ERROR',
    upstreamHttpStatus: 503,
    retryAfterAt: '2026-11-15T00:01:00.000Z',
  });
  assert.equal(retryAt, '2026-11-15T00:15:00.000Z');
});

test('honors a longer Retry-After and bounds external delay to seven days', () => {
  const retryAt = calculateFailureRetryAt({
    failedAt: '2026-11-15T00:00:00.000Z',
    errorCode: 'UPSTREAM_HTTP_ERROR',
    upstreamHttpStatus: 429,
    retryAfterAt: '2026-11-15T02:00:00.000Z',
  });
  assert.equal(retryAt, '2026-11-15T02:00:00.000Z');

  assert.equal(
    parseRetryAfterAt('999999999', Date.parse('2026-11-15T00:00:00.000Z')),
    '2026-11-22T00:00:00.000Z',
  );
});
