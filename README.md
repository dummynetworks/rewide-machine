# rewide-machine

**rewide-machine** is the crawler runtime behind rewide, deployed as a Cloudflare Worker.

It is kept separate from the rewide search frontend and search API.

## Cloudflare Worker API

The production entry point is `src/worker.js`, configured by `wrangler.jsonc`.

- `GET /health` — public Worker health check and configured capability flags.
- `POST /v1/crawl` — authenticated asynchronous crawl submission. Returns `202` and a `jobId`.
- `GET /v1/jobs/:jobId` — authenticated crawl job status.
- `GET /v1/documents?url=<encoded-url>` — authenticated stored document lookup.
- `POST /v1/crawl/once` — authenticated synchronous single-page extraction for diagnostics.

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

Apply the D1 schema to the remote database:

```sh
npx wrangler d1 migrations apply rewide-machine-db --remote
```

The initial migration, `migrations/0001_initial.sql`, creates:

- `crawl_jobs` — job state, attempt count, timestamps, and terminal errors.
- `documents` — the latest extracted document per URL, including title, description, canonical URL, language, text, links, and robots directives.

After the Queue exists and the migration has been applied, deploy the Worker. Wrangler will configure the producer binding `CRAWL_QUEUE` and the consumer for `rewide-crawl-queue` from `wrangler.jsonc`.

The consumer starts conservatively with batches of up to 5 messages, a 5-second batch timeout, one concurrent consumer invocation, and up to 5 retries. The application also uses bounded per-message retry delays for temporary failures.

Until the Queue binding and D1 tables are available, `GET /health` reports missing async capabilities and `POST /v1/crawl` returns `503 ASYNC_CRAWL_NOT_CONFIGURED`.

## Async crawl flow

1. The authenticated API validates the submitted public HTTP(S) URL.
2. It inserts a `queued` job row in D1.
3. It publishes `{ jobId, url }` to Cloudflare Queues.
4. The Queue consumer marks the job `running`, fetches and extracts one page, and atomically writes the document plus `completed` job state in a D1 batch.
5. Temporary consumer failures are retried with increasing delays. Invalid URLs, robots denials, and upstream HTTP errors are recorded as terminal failures.
6. The caller polls `GET /v1/jobs/:jobId`, then reads the saved document from `GET /v1/documents?url=...`.

Queue delivery is at-least-once, so document writes use URL-keyed upserts and the consumer acknowledges each message only after persistence. This milestone stores discovered outbound links but does not yet enqueue those links for recursive crawling. It also does not yet provide a search index.

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
