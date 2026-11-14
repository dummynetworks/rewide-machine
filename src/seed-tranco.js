import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTrancoSeeds, DEFAULT_SEED_LIMIT, MAX_SEED_LIMIT } from './tranco-seed.js';

const DEFAULT_WORKER_URL = 'https://rewide-machine.dummynet.workers.dev';

function usage() {
  return `Usage:
  npm run seed:tranco -- [options]

Options:
  --limit <1-${MAX_SEED_LIMIT}>       Number of Tranco domains to use (default: ${DEFAULT_SEED_LIMIT})
  --max-pages <1-50>      Pages to crawl per domain (default: 1)
  --max-depth <0-5>       Same-origin link depth (default: 0)
  --delay-ms <250+>       Delay between Worker submissions (default: 1000)
  --worker-url <https://…> Worker base URL (default: ${DEFAULT_WORKER_URL})
  --submit                Actually enqueue crawls; without this flag, only preview
  --help                  Show this help

The default run is a dry run. Each Tranco domain is submitted as one HTTPS root URL.
The Worker still enforces robots.txt, URL validation, same-origin scope, deduplication,
and the 24-hour watchTTL policy.
`;
}

function parseIntegerOption(args, name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const raw = args[index + 1];
  if (raw === undefined || raw.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function parseOptions(args) {
  const known = new Set([
    '--limit', '--max-pages', '--max-depth', '--delay-ms', '--worker-url', '--submit', '--help',
  ]);
  for (const arg of args) {
    if (arg.startsWith('--') && !known.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  const limit = parseIntegerOption(args, '--limit', DEFAULT_SEED_LIMIT, 1, MAX_SEED_LIMIT);
  const maxPages = parseIntegerOption(args, '--max-pages', 1, 1, 50);
  const maxDepth = parseIntegerOption(args, '--max-depth', maxPages > 1 ? 1 : 0, 0, 5);
  const delayMs = parseIntegerOption(args, '--delay-ms', 1000, 250, 60_000);
  const workerUrl = optionValue(args, '--worker-url', process.env.REWIDE_CRAWLER_URL || DEFAULT_WORKER_URL);

  if (maxPages === 1 && maxDepth !== 0) {
    throw new Error('--max-depth must be 0 when --max-pages is 1.');
  }

  let endpoint;
  try {
    const base = new URL(workerUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
      throw new Error('invalid');
    }
    endpoint = new URL('/v1/crawl', base).href;
  } catch {
    throw new Error('--worker-url must be a valid HTTPS base URL without credentials, query, or fragment.');
  }

  return {
    limit,
    maxPages,
    maxDepth,
    delayMs,
    endpoint,
    submit: args.includes('--submit'),
    help: args.includes('--help'),
  };
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function submitSeed(entry, options, token) {
  const response = await fetch(options.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      url: entry.url,
      maxPages: options.maxPages,
      maxDepth: options.maxDepth,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Preserve the HTTP status when the upstream response is not JSON.
  }

  if (response.status === 200 && payload?.status === 'fresh') {
    return { status: 'fresh', httpStatus: response.status, fetchedAt: payload.fetchedAt || null };
  }
  if (response.status === 202) {
    return {
      status: payload?.deduplicated === true ? 'deduplicated' : 'queued',
      httpStatus: response.status,
      jobId: payload?.jobId || null,
    };
  }

  return {
    status: 'failed',
    httpStatus: response.status,
    error: payload?.error || payload?.message || 'Unexpected Worker response.',
  };
}

async function writeReport(report, outputPath) {
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\\n`, 'utf8');
  return destination;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const token = process.env.DUMMYNET_TOKEN;
  if (options.submit && (typeof token !== 'string' || token.length < 24)) {
    throw new Error('DUMMYNET_TOKEN must be set to the Worker Secret before using --submit.');
  }

  const list = await fetchTrancoSeeds({ limit: options.limit });
  console.log(`Tranco list: ${list.listId} (${list.entries.length} domains)`);
  console.log(`Source: ${list.listUrl}`);
  console.log(`Worker: ${options.endpoint}`);
  console.log(`Crawl limit: maxPages=${options.maxPages}, maxDepth=${options.maxDepth}`);

  if (!options.submit) {
    console.log('DRY RUN — no Worker requests were sent. Add --submit to enqueue these seeds.');
    for (const entry of list.entries) {
      console.log(`#${entry.rank} ${entry.url}`);
    }
    return;
  }

  const results = [];
  const summary = {
    requested: 0,
    fresh: 0,
    queued: 0,
    deduplicated: 0,
    failed: 0,
    notSubmitted: 0,
  };

  for (let index = 0; index < list.entries.length; index += 1) {
    const entry = list.entries[index];
    if (index > 0) await sleep(options.delayMs);

    try {
      const result = await submitSeed(entry, options, token);
      results.push({ rank: entry.rank, domain: entry.domain, url: entry.url, ...result });
      summary.requested += 1;
      summary[result.status] += 1;
      console.log(`[${index + 1}/${list.entries.length}] #${entry.rank} ${entry.domain}: ${result.status}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}`);

      if (result.httpStatus === 401 || result.httpStatus === 403) {
        summary.notSubmitted = list.entries.length - index - 1;
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown submission failure.';
      results.push({ rank: entry.rank, domain: entry.domain, url: entry.url, status: 'failed', error: message });
      summary.requested += 1;
      summary.failed += 1;
      console.error(`[${index + 1}/${list.entries.length}] #${entry.rank} ${entry.domain}: failed (${message})`);
    }
  }

  const report = {
    schemaVersion: 1,
    source: list.source,
    listId: list.listId,
    listUrl: list.listUrl,
    downloadUrl: list.downloadUrl,
    listCreatedOn: list.createdOn,
    fetchedAt: list.fetchedAt,
    workerEndpoint: options.endpoint,
    crawl: {
      maxPages: options.maxPages,
      maxDepth: options.maxDepth,
      delayMs: options.delayMs,
    },
    summary,
    results,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = await writeReport(
    report,
    `data/tranco-seed-runs/${list.listId}-${stamp}.json`,
  );

  console.log('');
  console.log('Seed submission complete:');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Audit report: ${outputPath}`);

  if (summary.failed > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Tranco seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
