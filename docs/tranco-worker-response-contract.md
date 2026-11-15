# Tranco seeder — Worker response contract

This document records every JSON response currently returned by
`POST /v1/crawl` in `src/worker.js` and how `src/seed-tranco.js` classifies it.
It is intentionally scoped to this endpoint; the job, pages, health, document,
and one-shot crawl endpoints have separate response contracts.

## Successful responses

### 200 — fresh document

```json
{
  "url": "https://example.com/",
  "status": "fresh",
  "cached": true,
  "crawlRequired": false,
  "fetchedAt": "2026-11-15T00:00:00.000Z",
  "ttlExpiresAt": "2026-11-16T00:00:00.000Z"
}
```

Seeder result: `fresh`. No new crawl is required.

### 200 — failed-crawl cooldown

```json
{
  "url": "https://example.com/",
  "status": "cooldown",
  "cached": false,
  "crawlRequired": false,
  "retryAt": "2026-11-16T00:00:00.000Z",
  "previousFailureAt": "2026-11-15T00:00:00.000Z"
}
```

Seeder result: `cooldown`. This is a retry deferral, not a failed submission.

### 202 — newly queued crawl

```json
{
  "jobId": "d5b8b33b-ef33-4b39-90aa-e4cd0848a4c4",
  "url": "https://example.com/",
  "status": "queued",
  "createdAt": "2026-11-15T00:00:00.000Z",
  "maxPages": 1,
  "maxDepth": 0,
  "scope": "same-origin"
}
```

Seeder result: `queued`.

### 202 — existing active crawl

The `status` value is the active job status: `queued` or `running`.

```json
{
  "jobId": "d5b8b33b-ef33-4b39-90aa-e4cd0848a4c4",
  "url": "https://example.com/",
  "status": "running",
  "createdAt": "2026-11-15T00:00:00.000Z",
  "crawlRequired": false,
  "deduplicated": true,
  "maxPages": 1,
  "maxDepth": 0,
  "scope": "same-origin"
}
```

Seeder result: `deduplicated`.

## Error responses

| HTTP | `error` | Seeder classification | Behavior |
|---:|---|---|---|
| 503 | `NOT_CONFIGURED` | `failed / configuration` | Stop the batch |
| 401 | `UNAUTHORIZED` | `failed / authentication` | Stop the batch |
| 503 | `ASYNC_CRAWL_NOT_CONFIGURED` | `failed / configuration` | Stop the batch |
| 400 | `INVALID_JSON` | `failed / request` | Stop the batch |
| 413 | `REQUEST_TOO_LARGE` | `failed / request` | Stop the batch |
| 400 | `INVALID_REQUEST` | `failed / request` | Stop the batch |
| 400 | `INVALID_URL` | `rejected / url` | Record this URL and continue |
| 503 | `DISCOVERY_RECORD_FAILED` | `failed / storage` | Stop the batch |
| 503 | `WATCH_TTL_FAILED` | `failed / storage` | Stop the batch |
| 400 | `INVALID_CRAWL_LIMITS` | `failed / request` | Stop the batch |
| 503 | `QUEUE_ENQUEUE_FAILED` | `failed / queue` | Stop the batch |
| 405 | `METHOD_NOT_ALLOWED` | `failed / endpoint` | Stop the batch |
| 404 | `NOT_FOUND` | `failed / endpoint` | Stop the batch |

The concrete JSON bodies currently emitted by the Worker are:

### 503 — missing Worker token

```json
{
  "error": "NOT_CONFIGURED",
  "message": "DUMMYNET_TOKEN secret is required."
}
```

### 401 — invalid or missing authorization

```json
{
  "error": "UNAUTHORIZED"
}
```

### 503 — missing D1 or Queue binding

```json
{
  "error": "ASYNC_CRAWL_NOT_CONFIGURED",
  "message": "Bind the D1 database as DB and the Cloudflare Queue as CRAWL_QUEUE before using asynchronous crawling."
}
```

### 400 — invalid JSON

```json
{
  "error": "INVALID_JSON"
}
```

### 413 — request body too large

```json
{
  "error": "REQUEST_TOO_LARGE"
}
```

### 400 — missing or invalid URL field

```json
{
  "error": "INVALID_REQUEST",
  "message": "Provide one URL string in the url field."
}
```

### 400 — URL is not permitted

```json
{
  "error": "INVALID_URL",
  "message": "Only public HTTP and HTTPS URLs on standard ports are accepted."
}
```

### 503 — discovery record write failed

```json
{
  "error": "DISCOVERY_RECORD_FAILED"
}
```

### 503 — crawl history lookup failed

```json
{
  "error": "WATCH_TTL_FAILED",
  "message": "Unable to check the URL crawl history in D1."
}
```

### 400 — invalid crawl limits

```json
{
  "error": "INVALID_CRAWL_LIMITS",
  "message": "maxPages must be an integer from 1 to 50; maxDepth must be an integer from 0 to 5."
}
```

### 503 — queue submission failed

```json
{
  "error": "QUEUE_ENQUEUE_FAILED"
}
```

### 405 — unsupported HTTP method

```json
{
  "error": "METHOD_NOT_ALLOWED"
}
```

### 404 — unmatched route

```json
{
  "error": "NOT_FOUND"
}
```

## Unknown responses and report retention

The seeder keeps the complete parsed Worker JSON in each result's `workerResponse`
field. It also records `errorCode`, `errorMessage`, and a classification category.
A non-JSON response is preserved as `workerResponse: null` with its HTTP status.

Any response that does not match one of the known success or error contracts is
classified as `failed` and stops the current batch. This includes malformed 2xx
responses and new, unrecognized Worker error codes. This prevents an API contract
change or a shared service failure from being repeated for every remaining seed.

Only `INVALID_URL` is a per-entry rejection and does not stop the batch. The
Tranco parser already validates domain syntax; this classification remains a
defensive path for URL-level rejections at the Worker boundary.

## Test coverage

`test/seed-tranco-api.test.js` contains fixtures for all four successful response
variants, all thirteen error codes, malformed JSON, and unrecognized responses.
When a Worker response changes, update its fixture and this contract together.
