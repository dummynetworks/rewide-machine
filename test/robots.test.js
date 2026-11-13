import test from 'node:test';
import assert from 'node:assert/strict';
import { createRobotsPolicy } from '../src/robots.js';

test('respects disallow and allow directives for the crawler user-agent', () => {
  const policy = createRobotsPolicy({
    robotsUrl: 'https://example.com/robots.txt',
    status: 200,
    userAgent: 'rewidebot/0.1',
    body: `User-agent: rewidebot
Disallow: /private
Allow: /private/public
Crawl-delay: 2
Sitemap: https://example.com/sitemap.xml
`,
  });

  assert.equal(policy.allowed('https://example.com/private'), false);
  assert.equal(policy.allowed('https://example.com/private/public'), true);
  assert.equal(policy.crawlDelaySeconds, 2);
  assert.deepEqual(policy.sitemaps, ['https://example.com/sitemap.xml']);
});

test('treats a missing robots file as no published restrictions', () => {
  const policy = createRobotsPolicy({
    robotsUrl: 'https://example.com/robots.txt',
    status: 404,
    userAgent: 'rewidebot/0.1',
  });
  assert.equal(policy.mode, 'unavailable');
  assert.equal(policy.allowed('https://example.com/'), true);
});

test('fails closed when robots cannot be retrieved successfully', () => {
  const policy = createRobotsPolicy({
    robotsUrl: 'https://example.com/robots.txt',
    status: 503,
    userAgent: 'rewidebot/0.1',
  });
  assert.equal(policy.mode, 'blocked');
  assert.equal(policy.allowed('https://example.com/'), false);
});
