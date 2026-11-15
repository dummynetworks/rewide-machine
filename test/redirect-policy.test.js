import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedCrawlRedirect } from '../src/redirect-policy.js';

test('allows redirects that remain on the exact Origin', () => {
  assert.equal(
    isAllowedCrawlRedirect('https://example.com/next', 'https://example.com'),
    true,
  );
});

test('allows root redirects from HTTP to HTTPS on the same hostname', () => {
  assert.equal(
    isAllowedCrawlRedirect('https://example.com/', 'http://example.com', {
      allowRootWwwAlias: true,
    }),
    true,
  );
});

test('allows root redirects between apex and www hostnames', () => {
  assert.equal(
    isAllowedCrawlRedirect('https://www.example.com/', 'https://example.com', {
      allowRootWwwAlias: true,
    }),
    true,
  );
  assert.equal(
    isAllowedCrawlRedirect('https://example.com/', 'https://www.example.com', {
      allowRootWwwAlias: true,
    }),
    true,
  );
});

test('does not allow www alias redirects for recursive child pages', () => {
  assert.equal(
    isAllowedCrawlRedirect('https://www.example.com/about', 'https://example.com'),
    false,
  );
});

test('does not allow unrelated hosts or arbitrary subdomains', () => {
  assert.equal(
    isAllowedCrawlRedirect('https://example.net/', 'https://example.com', {
      allowRootWwwAlias: true,
    }),
    false,
  );
  assert.equal(
    isAllowedCrawlRedirect('https://login.example.com/', 'https://example.com', {
      allowRootWwwAlias: true,
    }),
    false,
  );
});

test('does not downgrade a secure root to HTTP', () => {
  assert.equal(
    isAllowedCrawlRedirect('http://www.example.com/', 'https://example.com', {
      allowRootWwwAlias: true,
    }),
    false,
  );
});
