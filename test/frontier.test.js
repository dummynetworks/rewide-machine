import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCrawlLinks } from '../src/frontier.js';

test('selects unique same-origin HTTP links and increments depth', () => {
  const result = selectCrawlLinks([
    'https://example.com/a',
    'https://example.com/a',
    'https://example.com/b#section',
    'https://other.example/page',
    'mailto:test@example.com',
  ], {
    rootUrl: 'https://example.com/',
    currentUrl: 'https://example.com/',
    depth: 0,
    maxDepth: 2,
  });

  assert.deepEqual(result, [
    {
      url: 'https://example.com/a',
      depth: 1,
      parentUrl: 'https://example.com/',
    },
    {
      url: 'https://example.com/b',
      depth: 1,
      parentUrl: 'https://example.com/',
    },
  ]);
});

test('stops at the configured depth and candidate limit', () => {
  assert.deepEqual(selectCrawlLinks(
    ['https://example.com/child'],
    {
      rootUrl: 'https://example.com/',
      currentUrl: 'https://example.com/parent',
      depth: 2,
      maxDepth: 2,
    },
  ), []);

  assert.equal(selectCrawlLinks(
    ['https://example.com/a', 'https://example.com/b'],
    {
      rootUrl: 'https://example.com/',
      currentUrl: 'https://example.com/',
      depth: 0,
      maxDepth: 1,
      limit: 1,
    },
  ).length, 1);
});
