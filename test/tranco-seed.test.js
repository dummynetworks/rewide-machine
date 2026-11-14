import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTrancoSeeds, parseTrancoCsv } from '../src/tranco-seed.js';

test('parseTrancoCsv parses ranked domains and applies the requested limit', () => {
  const entries = parseTrancoCsv(
    '1,google.com\n2,example.com\n3,sub.example.org\n',
    2,
  );

  assert.deepEqual(entries, [
    { rank: 1, domain: 'google.com', url: 'https://google.com/' },
    { rank: 2, domain: 'example.com', url: 'https://example.com/' },
  ]);
});

test('parseTrancoCsv normalizes internationalized domains to ASCII', () => {
  const [entry] = parseTrancoCsv('1,xn--bcher-kva.example\n', 1);
  assert.equal(entry.domain, 'xn--bcher-kva.example');
});

test('parseTrancoCsv rejects malformed rows and unsafe host forms', () => {
  assert.throws(() => parseTrancoCsv('rank,domain\n', 1), /Invalid rank/);
  assert.throws(() => parseTrancoCsv('1,localhost\n', 1), /Invalid domain/);
  assert.throws(() => parseTrancoCsv('1,127.0.0.1\n', 1), /Invalid domain/);
  assert.throws(() => parseTrancoCsv('1,example..com\n', 1), /Invalid domain/);
});

test('parseTrancoCsv rejects an empty or incomplete list', () => {
  assert.throws(() => parseTrancoCsv('', 10), /empty/);
  assert.equal(parseTrancoCsv('1,example.com\n', 10).length, 1);
});

test('fetchTrancoSeeds gets the latest list metadata and requested CSV prefix', async () => {
  const requests = [];
  const fetcher = async (url) => {
    requests.push(String(url));
    if (String(url).includes('/api/lists/date/latest')) {
      return new Response(JSON.stringify({
        list_id: 'AB12C',
        available: true,
        failed: false,
        created_on: '2026-11-13T22:00:00',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('1,example.com\n2,example.org\n', {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    });
  };

  const result = await fetchTrancoSeeds({ limit: 2, fetcher });

  assert.equal(result.listId, 'AB12C');
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].url, 'https://example.com/');
  assert.equal(requests.length, 2);
  assert.equal(requests[1], 'https://tranco-list.eu/download/AB12C/2');
});

test('fetchTrancoSeeds rejects unavailable Tranco lists', async () => {
  const fetcher = async () => new Response(JSON.stringify({
    list_id: 'AB12C',
    available: false,
    failed: false,
  }), { status: 200 });

  await assert.rejects(fetchTrancoSeeds({ limit: 1, fetcher }), /not available/);
});
