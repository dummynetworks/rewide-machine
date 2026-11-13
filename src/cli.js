import { RewideCrawler } from './crawler.js';

function printHelp() {
  console.log(`rewide-machine — rewidebot crawler

Usage:
  npm run crawl -- <seed-url> [seed-url...] [options]

Options:
  --max-pages <number>   Maximum HTML pages to request (default: 40)
  --max-depth <number>   Maximum link depth from seeds (default: 2)
  --delay-ms <number>    Minimum delay between requests to one origin (default: 1500)
  --output <path>        NDJSON output path (default: data/pages.ndjson)
  --help                 Show this help

Example:
  npm run crawl -- https://example.com --max-pages 20 --max-depth 2
`);
}

function parseArguments(args) {
  const seeds = [];
  const config = {};

  const optionMap = {
    'max-pages': 'maxPages',
    'max-depth': 'maxDepth',
    'delay-ms': 'minRequestIntervalMs',
    output: 'outputPath',
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--help' || argument === '-h') {
      return { help: true, seeds: [], config: {} };
    }

    if (!argument.startsWith('--')) {
      seeds.push(argument);
      continue;
    }

    const [rawName, inlineValue] = argument.slice(2).split('=', 2);
    const configKey = optionMap[rawName];
    if (!configKey) throw new Error(`Unknown option: --${rawName}`);

    const value = inlineValue ?? args[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${rawName}`);
    }

    config[configKey] = configKey === 'outputPath' ? value : Number(value);
  }

  return { help: false, seeds, config };
}

function printEvent(event) {
  const labels = {
    'page-stored': 'STORED',
    'page-skipped': 'SKIP',
    'page-error': 'ERROR',
    'robots-blocked': 'ROBOTS',
    'robots-unavailable': 'ROBOTS?',
    'sitemap-read': 'SITEMAP',
    'sitemap-skipped': 'SITEMAP SKIP',
    'sitemap-error': 'SITEMAP ERROR',
    'seed-rejected': 'REJECTED',
    'crawl-complete': 'DONE',
  };

  const label = labels[event.type] ?? event.type.toUpperCase();
  const target = event.url ?? event.input ?? '';
  const detail = event.message
    ?? event.reason
    ?? (event.status ? `HTTP ${event.status}` : '');

  console.log(`[${label}] ${target}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }

  if (parsed.seeds.length === 0) {
    printHelp();
    process.exitCode = 2;
    return;
  }

  const crawler = new RewideCrawler({
    config: parsed.config,
    onEvent: printEvent,
  });

  try {
    const stats = await crawler.run(parsed.seeds);
    console.log('\nCrawl summary');
    console.log(`  Requested:  ${stats.requested}`);
    console.log(`  Stored:     ${stats.stored}`);
    console.log(`  Indexable:  ${stats.indexable}`);
    console.log(`  Skipped:    ${stats.skipped}`);
    console.log(`  Discovered: ${stats.discovered}`);
    console.log(`  Output:     ${stats.outputPath}`);
  } finally {
    await crawler.close();
  }
}

main().catch((error) => {
  console.error(`rewide-machine: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
