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

test('treats ordinary 4xx robots responses as unavailable, but not HTTP 429', () => {
  for (const status of [401, 403, 404, 410]) {
    const policy = createRobotsPolicy({
      robotsUrl: 'https://example.com/robots.txt',
      status,
      userAgent: 'rewidebot/0.1',
    });
    assert.equal(policy.mode, 'unavailable');
    assert.equal(policy.allowed('https://example.com/'), true);
  }

  assert.throws(
    () => createRobotsPolicy({
      robotsUrl: 'https://example.com/robots.txt',
      status: 429,
      userAgent: 'rewidebot/0.1',
    }),
    /ROBOTS_FETCH_TEMPORARY_FAILURE/,
  );
});

test('does not turn server or network failures into a false robots disallow', () => {
  for (const status of [0, 301, 500, 503]) {
    assert.throws(
      () => createRobotsPolicy({
        robotsUrl: 'https://example.com/robots.txt',
        status,
        userAgent: 'rewidebot/0.1',
      }),
      /ROBOTS_FETCH_TEMPORARY_FAILURE/,
    );
  }
});
