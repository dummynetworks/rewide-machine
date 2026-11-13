export const DEFAULT_CONFIG = Object.freeze({
  userAgent: 'rewidebot/0.1',
  maxPages: 40,
  maxDepth: 2,
  requestTimeoutMs: 15_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxRobotsBytes: 512 * 1024,
  maxTextLength: 100_000,
  maxLinksPerPage: 500,
  maxRedirects: 5,
  minRequestIntervalMs: 1_500,
  outputPath: 'data/pages.ndjson',
});

function positiveInteger(name, value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

export function createConfig(overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };

  if (typeof config.userAgent !== 'string' || !/^[\w./()+ -]{3,120}$/.test(config.userAgent)) {
    throw new TypeError('userAgent must be a short, printable product token.');
  }

  positiveInteger('maxPages', config.maxPages, 100_000);
  if (!Number.isSafeInteger(config.maxDepth) || config.maxDepth < 0 || config.maxDepth > 20) {
    throw new RangeError('maxDepth must be an integer between 0 and 20.');
  }
  positiveInteger('requestTimeoutMs', config.requestTimeoutMs, 120_000);
  positiveInteger('maxResponseBytes', config.maxResponseBytes, 20 * 1024 * 1024);
  positiveInteger('maxRobotsBytes', config.maxRobotsBytes, 2 * 1024 * 1024);
  positiveInteger('maxTextLength', config.maxTextLength, 1_000_000);
  positiveInteger('maxLinksPerPage', config.maxLinksPerPage, 10_000);
  positiveInteger('maxRedirects', config.maxRedirects, 10);

  if (!Number.isSafeInteger(config.minRequestIntervalMs)
      || config.minRequestIntervalMs < 0
      || config.minRequestIntervalMs > 60_000) {
    throw new RangeError('minRequestIntervalMs must be between 0 and 60000.');
  }

  if (typeof config.outputPath !== 'string' || config.outputPath.trim() === '') {
    throw new TypeError('outputPath must be a non-empty path.');
  }

  return Object.freeze(config);
}
