import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicDestination, normalizeUrl } from '../src/url.js';

test('normalizes web URLs and removes fragments', () => {
  assert.equal(
    normalizeUrl('HTTPS://Example.COM:443/path#section'),
    'https://example.com/path',
  );
});

test('resolves relative links against their source URL', () => {
  assert.equal(
    normalizeUrl('../next', 'https://example.com/a/b'),
    'https://example.com/next',
  );
});

test('rejects unsupported protocols, credentials, local hosts and private IPs', () => {
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('https://user:pass@example.com/'), null);
  assert.equal(normalizeUrl('http://localhost/'), null);
  assert.equal(normalizeUrl('http://127.0.0.1/'), null);
  assert.equal(normalizeUrl('http://10.0.0.1/'), null);
  assert.equal(normalizeUrl('http://[::1]/'), null);
  assert.equal(normalizeUrl('https://example.com:8443/'), null);
});

test('rejects DNS answers that point to private networks', async () => {
  await assert.rejects(
    assertPublicDestination('https://example.com/', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.10', family: 4 },
    ]),
    /non-public address/,
  );
});

test('accepts a public DNS answer', async () => {
  const result = await assertPublicDestination(
    'https://example.com/',
    async () => [{ address: '93.184.216.34', family: 4 }],
  );
  assert.equal(result, 'https://example.com/');
});
