# rewide-machine

**rewide-machine** is the crawler runtime behind rewide, deployed as a Cloudflare Worker.

It is kept separate from the rewide search frontend and search API.

## Cloudflare Worker API

The production entry point is `src/worker.js`, configured by `wrangler.jsonc`.

- `GET /health` — public Worker health check and configured capability flags.
- `POST /v1/crawl` — authenticated asynchronous crawl submission. Returns `202` and a `jobId`.
- `GET /v1/jobs/:jobId` — authenticated crawl job status and page counters.
- `GET /v1/jobs/:jobId/pages` — authenticated per-URL frontier status for a crawl job.
- `GET /v1/documents?url=<encoded-url>` — authenticated stored document lookup.
- `POST /v1/crawl/once` — authenticated synchronous single-page extraction for diagnostics.

### Submit a crawl

A normal request remains a single-page crawl:

```http
POST /v1/crawl
Authorization: Bearer <DUMMYNET_TOKEN>
Content-Type: application/json

{"url":"https://example.com/"}
```

To follow links on the same origin, set bounded crawl limits:

```json
{
  "url": "https://example.com/",
  "maxPages": 20,
  "maxDepth": 2
}
```

- `maxPages`: total page limit including the starting URL; integer from 1 to 50. Defaults to 1.
- `maxDepth`: maximum link distance from the starting URL; integer from 0 to 5. Defaults to 0 for a single-page crawl and 2 when `maxPages` is greater than 1.
- Scope is same-origin only. Links to other hosts are not added to the frontier.
- URL fragments are removed before deduplication. Each normalized URL is added at most once per job.
- Every fetched page is checked against that page origin's `robots.txt`. A robots denial is recorded as a page failure and does not stop other queued pages.
- Per-page errors are visible in the pages endpoint. A crawl job completes when its frontier is drained and at least one page succeeded; it fails when no page succeeded.

Example response:

```json
{
  "jobId": "00000000-0000-4000-8000-000000000000",
  "url": "https://example.com/",
  "status": "queued",
  "maxPages": 20,
  "maxDepth": 2,
  "scope": "same-origin"
}
```

### Runtime secret

Create a Worker secret named `DUMMYNET_TOKEN` in Cloudflare **Settings → Variables & Secrets**. Choose the **Secret** type, not a plaintext variable. Use a long random value of at least 24 characters. Do not commit the value to Git or put it in the Workers Builds configuration.

The health endpoint does not require this token. All `/v1/*` endpoints require it as a Bearer token:

```http
Authorization: Bearer <DUMMYNET_TOKEN>
```

## Cloudflare resources

The Worker expects these runtime bindings:

| Binding | Resource |
| --- | --- |
| `DB` | D1 database `rewide-machine-db` |
| `CRAWL_QUEUE` | Queue `rewide-crawl-queue` |

The D1 database ID is configured in `wrangler.jsonc`. The Queue name and producer/consumer settings are also configured there. The Cloudflare Queue itself must exist before deployment.

Create the Queue once:

```sh
npx wrangler queues create rewide-crawl-queue
```

Apply all unapplied D1 migrations to the remote database:

```sh
npx wrangler d1 migrations apply rewide-machine-db --remote
```

Migrations:
- `0001_initial.sql` creates `crawl_jobs` and `documents`.
- `0002_recursive_crawl.sql` adds crawl limits and page counters to `crawl_jobs`, and creates the per-job `crawl_pages` frontier.
- `0003_documents_fts.sql` creates a SQLite FTS5 full-text index over document titles, descriptions, and extracted text. Triggers keep it synchronized with document inserts, updates, and deletes; the migration rebuilds the index from documents already stored.

After the Queue exists and migrations have been applied, deploy the Worker. Wrangler configures the producer binding `CRAWL_QUEUE` and the consumer for `rewide-crawl-queue` from `wrangler.jsonc`.

The consumer uses batches of up to 5 messages, a 5-second batch timeout, one concurrent consumer invocation, and up to 5 retries. The application also applies bounded per-message retry delays for temporary failures.

Until the Queue binding and D1 tables are available, `GET /health` reports missing async capabilities and `POST /v1/crawl` returns `503 ASYNC_CRAWL_NOT_CONFIGURED`.

## Async crawl flow

1. The authenticated API validates the starting URL and crawl limits.
2. It creates a crawl job and inserts the starting URL into the D1 frontier at depth 0.
3. It publishes the starting page as a Cloudflare Queue message.
4. The Queue consumer fetches and extracts one page, then discovers eligible same-origin links up to the configured depth and page limit.
5. Per-job URL uniqueness prevents repeated frontier entries. Each newly discovered page is inserted into D1 before it is published to the Queue.
6. The consumer stores each document and marks the corresponding frontier page complete in a D1 batch. Temporary failures are retried; terminal page failures are recorded and do not stop other pages.
7. The job becomes terminal when no frontier pages remain queued or running. Read its aggregate status from `GET /v1/jobs/:jobId` and page-level results from `GET /v1/jobs/:jobId/pages`.

Queue delivery is at-least-once. Duplicate messages are acknowledged when their frontier page is already terminal; document writes are URL-keyed upserts. If publishing a discovered child fails after its frontier row was inserted, retrying the parent can publish that still-queued child again.

This is a bounded same-origin crawler with a D1 FTS5 document index. The index is queried by the separate rewide Pages search API; the crawler itself does not expose a public search endpoint. It does not crawl external domains, execute JavaScript, render browser-only pages, or provide sitemap-driven discovery.

## Local development

Requirements: Node.js 22.19+ and npm.

```sh
npm install
npm run check
npm test
npm run dev
```

For local authenticated requests, create a local `.dev.vars` file (never commit it):

```dotenv
DUMMYNET_TOKEN="replace-with-a-long-random-local-secret"
```

Use local D1/Queue resources or configure Wrangler's local bindings before testing asynchronous routes.

## Node.js crawler prototype

The original sequential Node.js crawler remains available as a separate local prototype:

```sh
npm run crawl -- https://example.com --max-pages 20 --max-depth 2
```

It uses Cheerio, Undici, a DNS-validated transport, robots rules, and writes NDJSON to `data/pages.ndjson`. This Node.js CLI is not the Cloudflare Worker entry point.

## Deploy from Git

Cloudflare Workers Builds configuration:

| Setting | Value |
| --- | --- |
| Git repository | `dummynetworks/rewide-machine` |
| Production branch | `main` |
| Worker name | `rewide-machine` |
| Root directory | Repository root (`.`) |
| Build command | Leave blank |
| Deploy command | `npx wrangler deploy` |

The Worker name must match the `name` in `wrangler.jsonc`. Keep production and preview resources/secrets separate; do not point preview deployments at production data.

## Tests and validation

```sh
npm run check
npm test
npm run deploy:dry-run
```

The test suite uses mocked HTTP responses and fake D1 bindings. It does not crawl live websites.
