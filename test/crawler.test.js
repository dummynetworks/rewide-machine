import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RewideCrawler } from '../src/crawler.js';

test('crawls a seed, respects robots absence and stores one NDJSON record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rewide-machine-'));
  const outputPath = join(directory, 'pages.ndjson');

  const fetchImpl = async (input) => {
    const url = new URL(input);

    if (url.pathname === '/robots.txt') {
      return new Response(null, { status: 404 });
    }

    if (url.pathname === '/') {
      return new Response(
        '<html><head><title>Example</title></head><body><h1>It works</h1></body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }

    return new Response('Not found', { status: 404 });
  };

  const crawler = new RewideCrawler({
    config: {
      maxPages: 1,
      maxDepth: 0,
      minRequestIntervalMs: 0,
      outputPath,
    },
    fetchImpl,
    lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  try {
    const stats = await crawler.run(['https://example.com/']);
    const lines = (await readFile(outputPath, 'utf8')).trim().split('\n');
    const record = JSON.parse(lines[0]);

    assert.equal(stats.requested, 1);
    assert.equal(stats.stored, 1);
    assert.equal(stats.indexable, 1);
    assert.equal(lines.length, 1);
    assert.equal(record.title, 'Example');
    assert.match(record.text, /It works/);
    assert.equal(record.url, 'https://example.com/');
  } finally {
    await crawler.close();
    await rm(directory, { recursive: true, force: true });
  }
});
