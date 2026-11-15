export const ROBOTS_DISALLOWED_RETRY_MS = 24 * 60 * 60 * 1000;
export const CROSS_ORIGIN_REDIRECT_RETRY_MS = 24 * 60 * 60 * 1000;
export const UPSTREAM_TRANSIENT_RETRY_MS = 15 * 60 * 1000;
export const UPSTREAM_RATE_LIMIT_RETRY_MS = 60 * 60 * 1000;
export const UPSTREAM_CLIENT_ERROR_RETRY_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_FAILED_CRAWL_RETRY_MS = 60 * 60 * 1000;
export const MAX_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function parseRetryAfterAt(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null;

  const raw = value.trim();
  let timestamp;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds)) return null;
    timestamp = now + seconds * 1000;
  } else {
    timestamp = Date.parse(raw);
  }

  if (!Number.isFinite(timestamp)) return null;

  const bounded = Math.min(
    Math.max(timestamp, now),
    now + MAX_RETRY_AFTER_MS,
  );
  return new Date(bounded).toISOString();
}

export function getFailureRetryDelayMs(errorCode, upstreamHttpStatus = null) {
  switch (errorCode) {
    case 'ROBOTS_DISALLOWED':
      // Robots policy is respected and rechecked daily; this is not a success TTL.
      return ROBOTS_DISALLOWED_RETRY_MS;
    case 'CROSS_ORIGIN_REDIRECT':
      // Out-of-scope redirects are policy failures, not transient network errors.
      return CROSS_ORIGIN_REDIRECT_RETRY_MS;
    case 'UPSTREAM_HTTP_ERROR':
      if (upstreamHttpStatus === 429) return UPSTREAM_RATE_LIMIT_RETRY_MS;
      if ([408, 425].includes(upstreamHttpStatus) || upstreamHttpStatus >= 500) {
        return UPSTREAM_TRANSIENT_RETRY_MS;
      }
      if (upstreamHttpStatus >= 400 && upstreamHttpStatus < 500) {
        return UPSTREAM_CLIENT_ERROR_RETRY_MS;
      }
      return DEFAULT_FAILED_CRAWL_RETRY_MS;
    case 'ROBOTS_FETCH_TEMPORARY_FAILURE':
    case 'TEMPORARY_FAILURE':
    case 'RETRY_LIMIT_EXCEEDED':
    case 'CRAWL_FAILED':
      return UPSTREAM_TRANSIENT_RETRY_MS;
    default:
      return DEFAULT_FAILED_CRAWL_RETRY_MS;
  }
}

export function calculateFailureRetryAt({
  failedAt,
  errorCode,
  upstreamHttpStatus = null,
  retryAfterAt = null,
  retryMs,
}) {
  const failedAtMs = Date.parse(failedAt || '');
  if (!Number.isFinite(failedAtMs)) return null;

  const delayMs = Number.isFinite(retryMs)
    ? Math.max(0, retryMs)
    : getFailureRetryDelayMs(errorCode, upstreamHttpStatus);
  const policyRetryAt = failedAtMs + delayMs;
  const serverRetryAt = Date.parse(retryAfterAt || '');
  const timestamp = Number.isFinite(serverRetryAt)
    ? Math.max(policyRetryAt, serverRetryAt)
    : policyRetryAt;

  return new Date(timestamp).toISOString();
}
