import { createConfig } from './config.js';
import { extractDocument, extractSitemapLocations } from './extract.js';
import { createRobotsPolicy } from './robots.js';
import { createPageStore } from './store.js';
import { createCrawlerTransport } from './transport.js';
import { assertPublicDestination, normalizeUrl } from './url.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_QUEUE_SIZE = 10_000;
const MAX_SITEMAP_FILES = 20;

async function readLimitedBody(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    return { body: null, tooLarge: true };
  }

  if (!response.body) return { body: Buffer.alloc(0), tooLarge: false };

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return { body: null, tooLarge: true };
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return { body: Buffer.concat(chunks, total), tooLarge: false };
}

export class RewideCrawler {
  constructor(options = {}) {
    this.config = createConfig(options.config);
    this.transport = options.fetchImpl ? null : createCrawlerTransport();
    this.fetchImpl = options.fetchImpl ?? this.transport.fetch;
    this.lookupFn = options.lookupFn;
    this.onEvent = options.onEvent ?? (() => {});
    this.robotsCache = new Map();
    this.lastRequestAt = new Map();
    this.originIntervals = new Map();
  }

  emit(type, details = {}) {
    this.onEvent({ type, at: new Date().toISOString(), ...details });
  }

  async close() {
    await this.transport?.close();
  }

  async waitForOrigin(origin) {
    const interval = Math.max(
      this.config.minRequestIntervalMs,
      this.originIntervals.get(origin) ?? 0,
    );
    const last = this.lastRequestAt.get(origin) ?? 0;
    const waitMs = Math.max(0, interval - (Date.now() - last));

    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.lastRequestAt.set(origin, Date.now());
  }

  async request(input, { accept, maximumBytes, beforeRequest }) {
    let target = normalizeUrl(input);
    if (!target) throw new TypeError('Refusing an unsafe or unsupported URL.');

    for (let redirectCount = 0; redirectCount <= this.config.maxRedirects; redirectCount += 1) {
      await beforeRequest?.(target);
      target = await assertPublicDestination(target, this.lookupFn);
      const origin = new URL(target).origin;
      await this.waitForOrigin(origin);

      const response = await this.fetchImpl(target, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        headers: {
          'user-agent': this.config.userAgent,
          accept,
          'accept-language': 'en,ko;q=0.8,*;q=0.5',
        },
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();

        if (!location) throw new Error('Redirect response did not include a Location header.');
        if (redirectCount === this.config.maxRedirects) {
          throw new Error('Maximum redirect count exceeded.');
        }

        target = normalizeUrl(location, target);
        if (!target) throw new Error('Redirect target is not an allowed public HTTP URL.');
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        return { url: target, response, body: null, tooLarge: false };
      }

      const result = await readLimitedBody(response, maximumBytes);
      return {
        url: target,
        response,
        body: result.body,
        tooLarge: result.tooLarge,
      };
    }

    throw new Error('Maximum redirect count exceeded.');
  }

  async getRobotsPolicy(pageUrl, queue, queued) {
    const page = new URL(pageUrl);
    const origin = page.origin;
    if (this.robotsCache.has(origin)) return this.robotsCache.get(origin);

    const robotsUrl = new URL('/robots.txt', origin).href;
    let policy;

    try {
      const result = await this.request(robotsUrl, {
        accept: 'text/plain,*/*;q=0.1',
        maximumBytes: this.config.maxRobotsBytes,
      });

      if (result.tooLarge) {
        throw new Error('robots.txt exceeded the configured size limit.');
      }

      policy = createRobotsPolicy({
        robotsUrl,
        status: result.response.status,
        body: result.body?.toString('utf8') ?? '',
        userAgent: this.config.userAgent,
      });
    } catch (error) {
      policy = createRobotsPolicy({
        robotsUrl,
        status: 0,
        userAgent: this.config.userAgent,
      });
      this.emit('robots-unavailable', {
        url: robotsUrl,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (policy.crawlDelaySeconds) {
      this.originIntervals.set(origin, policy.crawlDelaySeconds * 1000);
    }

    this.robotsCache.set(origin, policy);

    for (const sitemapUrl of policy.sitemaps) {
      const normalized = normalizeUrl(sitemapUrl);
      if (normalized && !queued.has(`sitemap:${normalized}`) && queue.length < MAX_QUEUE_SIZE) {
        queued.add(`sitemap:${normalized}`);
        queue.push({ type: 'sitemap', url: normalized, depth: 0, sourceUrl: robotsUrl });
      }
    }

    return policy;
  }

  async processSitemap(item, queue, queued, sitemapCount) {
    if (sitemapCount >= MAX_SITEMAP_FILES) return sitemapCount;

    try {
      const result = await this.request(item.url, {
        accept: 'application/xml,text/xml,application/x-gzip,*/*;q=0.1',
        maximumBytes: this.config.maxResponseBytes,
        beforeRequest: async (target) => {
          const policy = await this.getRobotsPolicy(target, queue, queued);
          if (!policy.allowed(target)) {
            throw new Error('Sitemap target is disallowed by its robots.txt policy.');
          }
        },
      });

      if (!result.response.ok || result.tooLarge || !result.body) {
        this.emit('sitemap-skipped', { url: item.url, status: result.response.status });
        return sitemapCount + 1;
      }

      const locations = extractSitemapLocations(
        result.body.toString('utf8'),
        result.url,
        2_000,
      );

      for (const nested of locations.sitemaps.slice(0, 10)) {
        const key = `sitemap:${nested}`;
        if (!queued.has(key) && queue.length < MAX_QUEUE_SIZE) {
          queued.add(key);
          queue.push({
            type: 'sitemap',
            url: nested,
            depth: item.depth,
            sourceUrl: item.url,
          });
        }
      }

      for (const location of locations.pages) {
        const key = `page:${location}`;
        if (!queued.has(key) && queue.length < MAX_QUEUE_SIZE) {
          queued.add(key);
          queue.push({
            type: 'page',
            url: location,
            depth: item.depth,
            sourceUrl: item.url,
          });
        }
      }

      this.emit('sitemap-read', {
        url: item.url,
        pagesDiscovered: locations.pages.length,
        nestedSitemaps: locations.sitemaps.length,
      });
    } catch (error) {
      this.emit('sitemap-error', {
        url: item.url,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return sitemapCount + 1;
  }

  async run(seedUrls) {
    if (!Array.isArray(seedUrls) || seedUrls.length === 0) {
      throw new TypeError('Provide at least one seed URL.');
    }

    const queue = [];
    const queued = new Set();
    const seenPages = new Set();

    for (const seed of seedUrls) {
      const url = normalizeUrl(seed);
      if (!url) {
        this.emit('seed-rejected', { input: String(seed) });
        continue;
      }

      const key = `page:${url}`;
      if (!queued.has(key)) {
        queued.add(key);
        queue.push({ type: 'page', url, depth: 0, sourceUrl: null });
      }
    }

    if (queue.length === 0) throw new Error('No valid public HTTP or HTTPS seed URL was provided.');

    const store = await createPageStore(this.config.outputPath);
    const stats = {
      requested: 0,
      stored: 0,
      indexable: 0,
      skipped: 0,
      discovered: queue.length,
      outputPath: store.path,
    };
    let sitemapCount = 0;

    while (queue.length > 0 && stats.requested < this.config.maxPages) {
      const item = queue.shift();
      if (item.type === 'sitemap') {
        sitemapCount = await this.processSitemap(item, queue, queued, sitemapCount);
        continue;
      }

      if (seenPages.has(item.url)) continue;
      seenPages.add(item.url);
      stats.requested += 1;

      try {
        const policy = await this.getRobotsPolicy(item.url, queue, queued);
        if (!policy.allowed(item.url)) {
          stats.skipped += 1;
          this.emit('robots-blocked', { url: item.url });
          continue;
        }

        const result = await this.request(item.url, {
          accept: 'text/html,application/xhtml+xml;q=0.9',
          maximumBytes: this.config.maxResponseBytes,
          beforeRequest: async (target) => {
            const destinationPolicy = await this.getRobotsPolicy(target, queue, queued);
            if (!destinationPolicy.allowed(target)) {
              throw new Error('Redirect target is disallowed by its robots.txt policy.');
            }
          },
        });

        if (!result.response.ok || result.tooLarge || !result.body) {
          stats.skipped += 1;
          this.emit('page-skipped', {
            url: item.url,
            status: result.response.status,
            reason: result.tooLarge ? 'response-too-large' : 'http-status',
          });
          continue;
        }

        const contentType = result.response.headers.get('content-type') ?? '';
        if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(contentType)) {
          stats.skipped += 1;
          this.emit('page-skipped', {
            url: result.url,
            reason: 'unsupported-content-type',
            contentType,
          });
          continue;
        }

        const document = extractDocument(
          result.body,
          result.url,
          result.response.headers,
          this.config,
        );

        const record = {
          schemaVersion: 1,
          fetchedAt: new Date().toISOString(),
          httpStatus: result.response.status,
          contentType,
          depth: item.depth,
          sourceUrl: item.sourceUrl,
          ...document,
        };

        await store.write(record);
        stats.stored += 1;
        if (record.indexable) stats.indexable += 1;

        this.emit('page-stored', {
          url: record.url,
          title: record.title,
          indexable: record.indexable,
          textLength: record.text.length,
          links: record.links.length,
        });

        if (!record.noFollow && item.depth < this.config.maxDepth) {
          for (const link of record.links) {
            const key = `page:${link}`;
            if (queued.has(key) || queue.length >= MAX_QUEUE_SIZE) continue;
            queued.add(key);
            queue.push({
              type: 'page',
              url: link,
              depth: item.depth + 1,
              sourceUrl: record.url,
            });
            stats.discovered += 1;
          }
        }
      } catch (error) {
        stats.skipped += 1;
        this.emit('page-error', {
          url: item.url,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    stats.discovered = queued.size;
    this.emit('crawl-complete', stats);
    return stats;
  }
}
