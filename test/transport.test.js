import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicLookup } from '../src/transport.js';

function runLookup(lookup, hostname, options) {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

test('returns public DNS addresses in all mode', async () => {
  const lookup = createPublicLookup((hostname, options, callback) => {
    assert.equal(hostname, 'example.com');
    assert.equal(options.all, true);
    callback(null, [{ address: '93.184.216.34', family: 4 }]);
  });

  const result = await new Promise((resolve, reject) => {
    lookup('example.com', { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });

  assert.deepEqual(result, [{ address: '93.184.216.34', family: 4 }]);
});

test('blocks DNS answers that include a private address', async () => {
  const lookup = createPublicLookup((_hostname, _options, callback) => {
    callback(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
  });

  await assert.rejects(
    runLookup(lookup, 'rebinding.example', {}),
    /non-public DNS answers/,
  );
});

test('selects the requested address family', async () => {
  const lookup = createPublicLookup((_hostname, _options, callback) => {
    callback(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
  });

  const result = await runLookup(lookup, 'example.com', { family: 6 });
  assert.equal(result.address, '2606:2800:220:1:248:1893:25c8:1946');
  assert.equal(result.family, 6);
});
