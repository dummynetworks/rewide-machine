# rewide-machine

**rewide-machine** is the crawler runtime behind rewide, deployed as a Cloudflare Worker.

It is kept separate from the rewide search frontend and search API.

## Cloudflare Worker API

The production entry point is `src/worker.js`, configured by `wrangler.jsonc`.

- `GET /health` — public Worker health check and configured capability flags.
- `POST /v1/crawl` — authenticated asynchronous crawl submission. Returns `202` and a `jobId`.
- `GET /v1/jobs/:jobId` — authenticated crawl job status.
- `GET /v1/documents?url=<encoded-url>` — authenticated stored document lookup.
- `POST /v1/crawl/once` — authenticated synchronous single-page extraction endpoint for diagnostics.

### Runtime secret

Create a Worker secret named `DUMMYNET_TOKEN` in Cloudflare **Settings → Variables & Secrets**. Choose the **Secret** type, not a plaintext variable. Use a long random value of at least 24 characters. Do not commit the value to Git or put it in the Workers Builds configuration.

The health endpoint does not require this token. All `/v1/*` endpoints require it as a Bearer token:

```http
Authorization: Bearer <DUMMYNET_TOKEN>
```

## Queue and D1 resources

The asynchronous API requires both bindings:

- Queue producer/consumer binding: `CRAWL_QUEUE`
- D1 database binding: `DB`

Create the production resources in the Cloudflare account:

```sh
npx wrangler queues create rewide-crawl-queue
npx wrangler d1 create rewide-machine-db
```

The commands return resource information. Add the actual D1 `database_id` returned by Wrangler to `wrangler.jsonc`; do not use a made-up ID. Add these bindings to the existing Wrangler configuration:

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "rewide-machine-db",
      "database_id": "<ACTUAL_DATABASE_ID>",
      "migrations_dir": "migrations"
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "CRAWL_QUEUE",
        "queue": "rewide-crawl-queue"
      }
    ],
    "consumers": [
      {
        "queue": "rewide-crawl-queue",
        "max_batch_size": 5,
        "max_batch_timeout": 5,
        "max_retries": 5
      }
    ]
  }
}
```

Merge these keys into the existing root object in `wrangler.jsonc`; do not replace the existing `name`, `main`, `compatibility_date`, or `observability` keys. Apply the schema to the remote database:

```sh
npx wrangler d1 migrations apply rewide-machine-db --remote
```

The first migration creates:

- `crawl_jobs` — queue job state, attempt count, timestamps, and terminal errors.
- `documents` — latest extracted document per URL, including title, description, canonical URL, language, text, links, and robots directives.

Do not deploy the asynchronous endpoint until both bindings exist and the D1 migration has been applied. Until then, `GET /health` reports the missing capabilities and `POST /v1/crawl` returns `503 ASYNC_CRAWL_NOT_CONFIGURED`.

## Async crawl flow

1. The authenticated API validates the submitted public HTTP(S) URL.
2. It inserts a `queued` job row in D1.
3. It publishes `{ jobId, url }` to Cloudflare Queues.
4. The Queue consumer marks the job `running`, fetches and extracts one page, and atomically writes the document plus `completed` job state in a D1 batch.
5. Transient consumer failures are retried with increasing delays, up to five attempts. Invalid URLs, robots denials, and upstream HTTP errors are recorded as terminal failures.
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

Use local D1/Queue resources or configure Wrangler's local bindings before testing the asynchronous routes.

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
