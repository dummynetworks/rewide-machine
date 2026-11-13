# rewide-machine

**rewide-machine** is the standalone crawler runtime behind rewide. It is intentionally separate from the rewide search interface and search API.

The first milestone is a polite, single-process crawler that can discover public web pages, respect each origin's robots policy, extract static HTML documents, and write structured records.

## Runtime

- Node.js 22.19.0 or newer
- npm

Cheerio 1.2 and Undici 8 both require Node.js 22.19 or newer. The engine declaration is therefore intentional.

## Quick start

```sh
npm install
npm test
npm run check
npm run crawl -- https://example.com --max-pages 20 --max-depth 2
```

The crawler appends one JSON object per line to `data/pages.ndjson`. The output directory is created automatically and the file is not committed to Git.

Useful options:

| Option | Default | Meaning |
| --- | ---: | --- |
| `--max-pages` | `40` | Maximum number of HTML page requests |
| `--max-depth` | `2` | Link depth from the seed URLs |
| `--delay-ms` | `1500` | Minimum delay between requests to the same origin |
| `--output` | `data/pages.ndjson` | NDJSON output path |

Use `--help` to print the command syntax.

## Initial architecture

```text
Seed URLs
   |
   v
URL normalization and destination checks
   |
   v
robots.txt policy + sitemap discovery
   |
   v
Polite, bounded HTTP fetch
   |
   v
Static HTML extraction
   |
   v
NDJSON document store
```

### Current behavior

- Uses the `rewidebot/0.1` user-agent.
- Requests only HTTP and HTTPS on ports 80 and 443.
- Rejects URL credentials, localhost names, private IP literals, and DNS answers containing non-public addresses.
- Rechecks DNS answers in the socket connector so a changed DNS answer cannot silently route a connection to a private address.
- Follows a maximum of five redirects and validates each redirect target.
- Checks the destination origin's robots policy before fetching a page or a redirected page.
- Uses a minimum per-origin request interval of 1.5 seconds unless a longer `Crawl-delay` is published.
- Treats an unavailable robots file (404 or 410) as having no published rules. Other retrieval failures fail closed.
- Caps HTML and sitemap responses at 2 MiB and robots files at 512 KiB.
- Extracts titles, descriptions, canonical URLs, language, readable text, robots directives, and bounded outbound links.
- Keeps `noindex` documents in the crawl output with `indexable: false`; it does not silently discard the crawl record.
- Does not follow page links from a `nofollow` document or links marked `rel="nofollow"`.

## Output record

Each line in `pages.ndjson` is a standalone JSON object. The record includes:

- crawl time, final URL, HTTP status, content type, depth, and discovery source
- title, description, canonical URL, and language
- extracted text and discovered links
- `noIndex`, `noFollow`, and `indexable` flags

## Scope and non-goals of this milestone

This is a crawler foundation, not yet a complete search engine.

- HTML is parsed as received; JavaScript is not executed and browser-rendered pages are not generated.
- PDF, images, video, and other binary formats are not indexed.
- The frontier is in-memory for one run. It is not a distributed queue and does not resume unfinished work after a process exits.
- NDJSON is the initial inspectable storage format. There is not yet a durable document database, deduplication service, ranking pipeline, or search-serving API.
- The crawler is sequential by design in this milestone. Per-origin politeness takes priority over throughput.

The rewide search frontend does not call this process directly yet. A later indexing and serving layer will consume the document records through an explicit contract.

## Development

```sh
npm test
npm run check
```

Tests use Node's built-in test runner and mocked HTTP responses. They do not crawl live websites.
