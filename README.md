# rewide-machine

**rewide-machine** is the crawler runtime behind rewide, deployed as a Cloudflare Worker.

It is kept separate from the rewide search frontend and search API.

## Cloudflare Worker

The production entry point is `src/worker.js`, configured by `wrangler.jsonc`.

- `GET /health` — public Worker health check.
- `POST /v1/crawl` — authenticated, single-page HTML fetch and extraction endpoint.

The crawl endpoint requires the `DUMMYNET_TOKEN` runtime secret. Send it as a Bearer token:

```http
POST /v1/crawl
Authorization: Bearer <DUMMYNET_TOKEN>
Content-Type: application/json

{"url":"https://example.com/"}
```

The Worker validates the URL scheme, port, credentials, localhost names, and literal private/reserved IP ranges. It checks the destination origin's `robots.txt`, follows a bounded number of redirects, checks the destination robots policy after each redirect, caps responses, accepts HTML only, and extracts page metadata, readable text, canonical URL, and outbound links with Cloudflare `HTMLRewriter`.

This is the first Worker milestone: a request performs one page fetch and returns the extracted document. It does **not** yet persist pages, run a background crawl frontier, or provide a search index.

### Runtime secret

Create a Worker secret named `DUMMYNET_TOKEN` in Cloudflare **Settings → Variables & Secrets**. Choose the **Secret** type, not a plaintext variable. Use a long random value of at least 24 characters. Do not commit the value to Git or put it in the Workers Builds configuration.

The health endpoint does not require this token. The crawl endpoint returns `503 NOT_CONFIGURED` until the secret is set and `401 UNAUTHORIZED` for an invalid token.

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
| Non-production deploy | Leave Cloudflare's default until a separate preview secret/environment is configured |

The Worker name must match the `name` in `wrangler.jsonc`.

The Worker uses no build framework; Wrangler bundles the Worker entry point during deploy. The Git integration's default deploy command is `npx wrangler deploy`.

## Local development

Requirements: Node.js 22.19+ and npm.

```sh
npm install
npm run check
npm test
npm run dev
```

For local authenticated crawl requests, create a local `.dev.vars` file (never commit it):

```dotenv
DUMMYNET_TOKEN="replace-with-a-long-random-local-secret"
```

Call the local endpoint at `http://localhost:8787/v1/crawl`.

## Node.js crawler prototype

The original sequential Node.js crawler remains available as a separate local prototype:

```sh
npm run crawl -- https://example.com --max-pages 20 --max-depth 2
```

It uses Cheerio, Undici, a DNS-validated transport, robots rules, and writes NDJSON to `data/pages.ndjson`. This Node.js CLI is not the Cloudflare Worker entry point.

## Next milestones

1. Add a durable URL frontier with Cloudflare Queues.
2. Persist crawl records and job state using D1 and R2.
3. Add retry/backoff, scheduled recrawls, canonical deduplication, and sitemap queueing.
4. Define the document schema and connect it to rewide's indexing and retrieval pipeline.
5. Add isolated preview resources and secrets.

The current Worker does not yet use D1, R2, or Queues. Create those Cloudflare resources before adding the corresponding bindings to `wrangler.jsonc`.

## Tests and validation

```sh
npm run check
npm test
npm run deploy:dry-run
```

The test suite uses mocked HTTP responses. It does not crawl live websites.
