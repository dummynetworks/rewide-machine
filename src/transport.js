import { lookup } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { isPublicIpAddress } from './url.js';

export function createPublicLookup(resolver = lookup) {
  return function publicLookup(hostname, options, callback) {
    let lookupOptions = options;
    let done = callback;

    if (typeof lookupOptions === 'function') {
      done = lookupOptions;
      lookupOptions = {};
    }

    resolver(hostname, { all: true, verbatim: true }, (error, records) => {
      if (error) {
        done(error);
        return;
      }

      if (!Array.isArray(records) || records.length === 0) {
        done(new Error(`No address records returned for ${hostname}.`));
        return;
      }

      if (records.some((record) => !isPublicIpAddress(record.address))) {
        done(new Error(`Refusing non-public DNS answers for ${hostname}.`));
        return;
      }

      const family = lookupOptions?.family ?? 0;
      const matching = family
        ? records.filter((record) => record.family === family)
        : records;

      if (matching.length === 0) {
        done(new Error(`No address records for requested IP family: ${hostname}.`));
        return;
      }

      if (lookupOptions?.all) {
        done(null, matching);
        return;
      }

      const selected = matching[0];
      done(null, selected.address, selected.family);
    });
  };
}

export function createCrawlerTransport() {
  const dispatcher = new Agent({
    connections: 1,
    maxOrigins: 256,
    connect: {
      lookup: createPublicLookup(),
    },
  });

  return {
    fetch(input, options = {}) {
      return undiciFetch(input, {
        ...options,
        dispatcher,
      });
    },

    async close() {
      await dispatcher.close();
    },
  };
}
