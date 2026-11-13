import { createRobotsPolicy } from './robots.js';
import { insertCrawlJob, getCrawlJob, updateCrawlJob, insertCrawlPage, getCrawlPage, getCrawlPages, updateCrawlPage, saveDocumentAndCompletePage, failCrawlPage, finalizeCrawlJobIfIdle, getDocument } from './job-store.js';
import { selectCrawlLinks } from './frontier.js';

const USER_AGENT = 'rewidebot/0.1';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
const MAX_TEXT_LENGTH = 100_000;
const MAX_LINKS = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const ROBOTS_CACHE_TTL_MS = 10 * 60 * 1000;
const robotsCache = new Map();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function isPrivateIPv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }

  const [a, b, c] = parts;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
  );
}

function isBlockedIPv6(host) {
  const value = host.toLowerCase();
  return (
    value === '::'
    || value === '::1'
    || value.startsWith('::ffff:')
    || value.startsWith('2001:db8:')
    || value.startsWith('2001:0:')
    || value.startsWith('2002:')
    || value.startsWith('64:ff9b:')
    || value.startsWith('fc')
    || value.startsWith('fd')
    || /^fe[89ab]/.test(value)
    || value.startsWith('ff')
  );
}

function normalizePublicUrl(input, base) {
  try {
    const url = base ? new URL(input, base) : new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;

    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host || host === 'localhost') return null;
    if (['.localhost', '.local', '.internal', '.test'].some((suffix) => host.endsWith(suffix))) {
      return null;
    }

    if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) return null;

    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && isPrivateIPv4(host)) return null;
    if (host.includes(':') && isBlockedIPv6(host)) return null;

    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

async function readLimitedBody(response, limit) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel();
    return null;
  }

  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;

      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function getRobotsPolicy(targetUrl) {
  const target = new URL(targetUrl);
  const origin = target.origin;
  const cached = robotsCache.get(origin);

  if (cached && cached.expiresAt > Date.now()) return cached.policy;

  const robotsUrl = new URL('/robots.txt', origin).href;
  let policy;

  try {
    const response = await fetch(robotsUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, accept: 'text/plain,*/*;q=0.1' },
    });

    const body = response.ok ? await readLimitedBody(response, MAX_ROBOTS_BYTES) : null;
    if (response.ok && body === null) {
      policy = createRobotsPolicy({
        robotsUrl, status: 0, userAgent: USER_AGENT,
      });
    } else {
      policy = createRobotsPolicy({
        robotsUrl,
        status: response.status,
        body: body ? new TextDecoder().decode(body) : '',
        userAgent: USER_AGENT,
      });
    }
  } catch {
    policy = createRobotsPolicy({
      robotsUrl, status: 0, userAgent: USER_AGENT,
    });
  }

  robotsCache.set(origin, {
    policy,
    expiresAt: Date.now() + ROBOTS_CACHE_TTL_MS,
  });

  return policy;
}

function collectDocument(htmlResponse, finalUrl) {
  const document = {
    url: finalUrl,
    title: '',
    description: '',
    canonicalUrl: null,
    language: null,
    text: '',
    links: [],
    noIndex: false,
    noFollow: false,
    indexable: true,
  };

  const addText = (target, chunk, limit) => {
    if (target.length < limit) target += chunk;
    return target.slice(0, limit);
  };

  let bodyResponse;
  const rewriter = new HTMLRewriter()
    .on('html', {
      element(element) {
        document.language = element.getAttribute('lang')?.trim().slice(0, 35) || null;
      },
    })
    .on('title', {
      text(chunk) {
        document.title = addText(document.title, chunk.text, 500);
      },
    })
    .on('meta', {
      element(element) {
        const name = (element.getAttribute('name') || '').toLowerCase();
        const property = (element.getAttribute('property') || '').toLowerCase();
        const content = element.getAttribute('content') || '';

        if (name === 'description' || property === 'og:description') {
          if (!document.description) document.description = content.trim().slice(0, 2_000);
        }

        if (name === 'robots' || name === 'rewidebot') {
          const directives = content.toLowerCase().split(/[;,\s]+/);
          if (directives.includes('noindex') || directives.includes('none')) {
            document.noIndex = true;
          }
          if (directives.includes('nofollow') || directives.includes('none')) {
            document.noFollow = true;
          }
        }
      },
    })
    .on('link[rel~="canonical"]', {
      element(element) {
        const href = element.getAttribute('href');
        if (href) document.canonicalUrl = normalizePublicUrl(href, finalUrl);
      },
    })
    .on('a[href]', {
      element(element) {
        if (document.links.length >= MAX_LINKS || document.noFollow) return;
        const rel = (element.getAttribute('rel') || '').toLowerCase().split(/\s+/);
        if (rel.includes('nofollow')) return;

        const href = element.getAttribute('href');
        const link = href ? normalizePublicUrl(href, finalUrl) : null;
        if (link && link !== finalUrl && !document.links.includes(link)) {
          document.links.push(link);
        }
      },
    })
    .on('body, body *', {
      text(chunk) {
        document.text = addText(document.text, chunk.text, MAX_TEXT_LENGTH);
      },
    })
    .on('script,style,noscript,template,svg,canvas,iframe,nav,footer,form,aside,[hidden],[aria-hidden="true"]', {
      element(element) {
        element.remove();
      },
    });

  bodyResponse = rewriter.transform(htmlResponse);
  return bodyResponse.text().then(() => {
    const headerDirectives = (htmlResponse.headers.get('x-robots-tag') || '')
      .toLowerCase()
      .split(/[;,\s]+/);

    if (headerDirectives.includes('noindex') || headerDirectives.includes('none')) {
      document.noIndex = true;
    }
    if (headerDirectives.includes('nofollow') || headerDirectives.includes('none')) {
      document.noFollow = true;
    }

    document.title = document.title.replace(/\s+/g, ' ').trim();
    document.description = document.description.replace(/\s+/g, ' ').trim();
    document.text = document.text.replace(/[\t\n\r ]+/g, ' ').trim();
    document.indexable = !document.noIndex;
    if (document.noFollow) document.links = [];
    return document;
  });
}

async function crawlOne(input) {
  let target = normalizePublicUrl(input);
  if (!target) {
    return { error: 'INVALID_URL', message: 'Only public HTTP and HTTPS URLs on standard ports are accepted.' };
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const policy = await getRobotsPolicy(target);
    if (!policy.allowed(target)) {
      return { error: 'ROBOTS_DISALLOWED', message: 'robots.txt disallows this URL.' };
    }

    const response = await fetch(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9',
        'accept-language': 'en,ko;q=0.8,*;q=0.5',
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();

      if (!location || redirects === MAX_REDIRECTS) {
        return { error: 'REDIRECT_LIMIT', message: 'Missing redirect target or maximum redirects exceeded.' };
      }

      target = normalizePublicUrl(location, target);
      if (!target) {
        return { error: 'INVALID_REDIRECT', message: 'Redirect target is not an allowed public HTTP URL.' };
      }
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      return { error: 'UPSTREAM_HTTP_ERROR', status: response.status };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(contentType)) {
      await response.body?.cancel();
      return { error: 'UNSUPPORTED_CONTENT_TYPE', contentType };
    }

    const bytes = await readLimitedBody(response, MAX_PAGE_BYTES);
    if (!bytes) {
      return { error: 'RESPONSE_TOO_LARGE', message: 'HTML response exceeded 2 MiB.' };
    }

    const safeResponse = new Response(bytes, {
      status: response.status,
      headers: response.headers,
    });
    const document = await collectDocument(safeResponse, target);

    return {
      schemaVersion: 1,
      fetchedAt: new Date().toISOString(),
      httpStatus: response.status,
      contentType,
      ...document,
    };
  }

  return { error: 'REDIRECT_LIMIT' };
}

async function authorized(request, env) {
  const expected = env.DUMMYNET_TOKEN;
  if (typeof expected !== 'string' || expected.length < 24) return false;

  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(match[1])),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);

  const a = new Uint8Array(providedHash);
  const b = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function requestUrl(payload) {
  if (!payload || typeof payload.url !== 'string' || payload.url.length > 2_048) {
    return { error: 'INVALID_REQUEST', message: 'Provide one URL string in the url field.' };
  }
  const url = normalizePublicUrl(payload.url);
  if (!url) {
    return { error: 'INVALID_URL', message: 'Only public HTTP and HTTPS URLs on standard ports are accepted.' };
  }
  return { url };
}

async function readJsonBody(request) {
  const declaredBodyLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredBodyLength) && declaredBodyLength > 4_096) {
    return { error: 'REQUEST_TOO_LARGE' };
  }
  try {
    const body = await request.text();
    if (body.length > 4_096) return { error: 'REQUEST_TOO_LARGE' };
    return { payload: JSON.parse(body) };
  } catch {
    return { error: 'INVALID_JSON' };
  }
}

async function crawlOnceResponse(payload) {
  const checked = requestUrl(payload);
  if (checked.error) {
    return json({ error: checked.error, message: checked.message }, checked.error === 'INVALID_URL' ? 400 : 400);
  }

  try {
    const result = await crawlOne(checked.url);
    const status = result.error
      ? (result.error === 'ROBOTS_DISALLOWED' ? 403
        : result.error === 'INVALID_URL' || result.error === 'INVALID_REDIRECT' ? 400
          : result.error === 'UPSTREAM_HTTP_ERROR' ? 502 : 422)
      : 200;
    return json(result, status);
  } catch (error) {
    return json({
      error: 'CRAWL_FAILED',
      message: error instanceof Error ? error.message : 'Unexpected crawler error.',
    }, 502);
  }
}

async function handleQueueMessage(message, env) {
  const body = message.body;
  if (!body || typeof body.jobId !== 'string' || typeof body.url !== 'string') {
    message.ack();
    return;
  }

  const depthFromMessage = Number.isInteger(body.depth) ? body.depth : 0;
  if (depthFromMessage < 0 || depthFromMessage > 5) {
    message.ack();
    return;
  }

  let pageUrl = body.url;
  try {
    const job = await getCrawlJob(env.DB, body.jobId);
    if (!job) {
      message.ack();
      return;
    }

    if (job.status === 'completed' || job.status === 'failed') {
      message.ack();
      return;
    }

    let page = await getCrawlPage(env.DB, body.jobId, pageUrl);
    if (!page) {
      await insertCrawlPage(env.DB, {
        jobId: body.jobId,
        url: pageUrl,
        depth: depthFromMessage,
        parentUrl: typeof body.parentUrl === 'string' ? body.parentUrl : null,
      });
      page = await getCrawlPage(env.DB, body.jobId, pageUrl);
    }

    if (!page) {
      message.ack();
      return;
    }

    if (page.status === 'completed' || page.status === 'failed') {
      await finalizeCrawlJobIfIdle(env.DB, body.jobId);
      message.ack();
      return;
    }

    await updateCrawlPage(env.DB, body.jobId, pageUrl, {
      status: 'running',
      attempts: message.attempts,
      updated_at: new Date().toISOString(),
      error_code: null,
      error_message: null,
    });
    await updateCrawlJob(env.DB, body.jobId, {
      status: 'running',
      attempts: message.attempts,
      updated_at: new Date().toISOString(),
      error_code: null,
      error_message: null,
    });

    const result = await crawlOne(pageUrl);
    if (result.error) {
      await failCrawlPage(env.DB, body.jobId, pageUrl, {
        attempts: message.attempts,
        errorCode: result.error,
        errorMessage: result.message || result.error,
      });
      await finalizeCrawlJobIfIdle(env.DB, body.jobId);
      message.ack();
      return;
    }

    const currentDepth = Number(page.depth || depthFromMessage);
    const candidates = selectCrawlLinks(result.links, {
      rootUrl: job.url,
      currentUrl: pageUrl,
      depth: currentDepth,
      maxDepth: Number(job.max_depth || 0),
      limit: 50,
    });

    for (const candidate of candidates) {
      await insertCrawlPage(env.DB, {
        jobId: body.jobId,
        url: candidate.url,
        depth: candidate.depth,
        parentUrl: candidate.parentUrl,
      });

      // Re-send only this page's queued discoveries. If a prior delivery
      // failed after the D1 insert, retrying the parent can publish them.
      const discoveredPage = await getCrawlPage(env.DB, body.jobId, candidate.url);
      if (discoveredPage?.status === 'queued') {
        await env.CRAWL_QUEUE.send({
          jobId: body.jobId,
          url: candidate.url,
          depth: candidate.depth,
          parentUrl: candidate.parentUrl,
        });
      }
    }

    await saveDocumentAndCompletePage(env.DB, body.jobId, pageUrl, result);
    await finalizeCrawlJobIfIdle(env.DB, body.jobId);
    message.ack();
  } catch (error) {
    const messageText = error instanceof Error ? error.message.slice(0, 500) : 'Unexpected queue consumer error.';
    const currentPage = await getCrawlPage(env.DB, body.jobId, pageUrl).catch(() => null);

    if (currentPage?.status === 'completed' || currentPage?.status === 'failed') {
      message.retry({ delaySeconds: 15 });
      return;
    }

    if (message.attempts >= 5) {
      try {
        await failCrawlPage(env.DB, body.jobId, pageUrl, {
          attempts: message.attempts,
          errorCode: 'RETRY_LIMIT_EXCEEDED',
          errorMessage: messageText,
        });
        await finalizeCrawlJobIfIdle(env.DB, body.jobId);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 900 });
      }
      return;
    }

    try {
      await updateCrawlPage(env.DB, body.jobId, pageUrl, {
        status: 'queued',
        attempts: message.attempts,
        updated_at: new Date().toISOString(),
        error_code: 'TEMPORARY_FAILURE',
        error_message: messageText,
      });
      await updateCrawlJob(env.DB, body.jobId, {
        status: 'queued',
        attempts: message.attempts,
        updated_at: new Date().toISOString(),
        error_code: 'TEMPORARY_FAILURE',
        error_message: messageText,
      });
    } catch {
      // The Queue retry remains the source of truth if D1 is temporarily unavailable.
    }

    const delaySeconds = Math.min(900, 15 * (2 ** Math.max(0, message.attempts - 1)));
    message.retry({ delaySeconds });
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({
        service: 'rewide-machine',
        bot: USER_AGENT,
        status: 'ok',
        runtime: 'cloudflare-workers',
        version: '0.3.0',
        capabilities: {
          queue: Boolean(env.CRAWL_QUEUE),
          database: Boolean(env.DB),
          asyncCrawl: Boolean(env.CRAWL_QUEUE && env.DB),
          recursiveCrawl: true,
        },
      });
    }

    if (!['GET', 'POST'].includes(request.method)) {
      return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'GET, POST' });
    }

    if (!await authorized(request, env)) {
      if (request.method === 'POST' && url.pathname === '/v1/crawl') {
        if (!env.DUMMYNET_TOKEN) {
          return json({ error: 'NOT_CONFIGURED', message: 'DUMMYNET_TOKEN secret is required.' }, 503);
        }
      }
      return json({ error: 'UNAUTHORIZED' }, 401, { 'www-authenticate': 'Bearer' });
    }

    const pagesMatch = url.pathname.match(/^\\/v1\\/jobs\\/([0-9a-f-]{36})\\/pages$/i);
    if (request.method === 'GET' && pagesMatch) {
      if (!env.DB) return json({ error: 'DATABASE_NOT_CONFIGURED' }, 503);
      const jobId = pagesMatch[1];
      const job = await getCrawlJob(env.DB, jobId);
      if (!job) return json({ error: 'JOB_NOT_FOUND' }, 404);
      const pages = await getCrawlPages(env.DB, jobId);
      return json({ jobId, count: pages.length, pages });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/v1/jobs/')) {
      if (!env.DB) return json({ error: 'DATABASE_NOT_CONFIGURED' }, 503);
      const jobId = url.pathname.slice('/v1/jobs/'.length);
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ error: 'INVALID_JOB_ID' }, 400);
      const job = await getCrawlJob(env.DB, jobId);
      return job ? json(job) : json({ error: 'JOB_NOT_FOUND' }, 404);
    }

    if (request.method === 'GET' && url.pathname === '/v1/documents') {
      if (!env.DB) return json({ error: 'DATABASE_NOT_CONFIGURED' }, 503);
      const target = normalizePublicUrl(url.searchParams.get('url') || '');
      if (!target) return json({ error: 'INVALID_URL' }, 400);
      const document = await getDocument(env.DB, target);
      return document ? json(document) : json({ error: 'DOCUMENT_NOT_FOUND' }, 404);
    }

    if (request.method === 'POST' && url.pathname === '/v1/crawl/once') {
      const parsed = await readJsonBody(request);
      if (parsed.error) return json({ error: parsed.error }, parsed.error === 'REQUEST_TOO_LARGE' ? 413 : 400);
      return crawlOnceResponse(parsed.payload);
    }

    if (request.method === 'POST' && url.pathname === '/v1/crawl') {
      if (!env.DB || !env.CRAWL_QUEUE) {
        return json({
          error: 'ASYNC_CRAWL_NOT_CONFIGURED',
          message: 'Bind the D1 database as DB and the Cloudflare Queue as CRAWL_QUEUE before using asynchronous crawling.',
        }, 503);
      }

      const parsed = await readJsonBody(request);
      if (parsed.error) return json({ error: parsed.error }, parsed.error === 'REQUEST_TOO_LARGE' ? 413 : 400);
      const checked = requestUrl(parsed.payload);
      if (checked.error) return json({ error: checked.error, message: checked.message }, 400);

      const requestedMaxPages = parsed.payload?.maxPages ?? 1;
      const requestedMaxDepth = parsed.payload?.maxDepth ?? (requestedMaxPages > 1 ? 2 : 0);
      if (
        !Number.isInteger(requestedMaxPages)
        || requestedMaxPages < 1
        || requestedMaxPages > 50
        || !Number.isInteger(requestedMaxDepth)
        || requestedMaxDepth < 0
        || requestedMaxDepth > 5
      ) {
        return json({
          error: 'INVALID_CRAWL_LIMITS',
          message: 'maxPages must be an integer from 1 to 50; maxDepth must be an integer from 0 to 5.',
        }, 400);
      }

      const jobId = crypto.randomUUID();
      const now = new Date().toISOString();
      try {
        await insertCrawlJob(env.DB, {
          id: jobId,
          url: checked.url,
          maxPages: requestedMaxPages,
          maxDepth: requestedMaxDepth,
          now,
        });
        await insertCrawlPage(env.DB, {
          jobId,
          url: checked.url,
          depth: 0,
          parentUrl: null,
          now,
        });
        await env.CRAWL_QUEUE.send({ jobId, url: checked.url, depth: 0, parentUrl: null });
      } catch (error) {
        try {
          await failCrawlPage(env.DB, jobId, checked.url, {
            attempts: 0,
            errorCode: 'QUEUE_ENQUEUE_FAILED',
            errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'Unable to enqueue crawl job.',
          });
          await finalizeCrawlJobIfIdle(env.DB, jobId);
        } catch {
          // Preserve the original enqueue failure response.
        }
        return json({ error: 'QUEUE_ENQUEUE_FAILED' }, 503);
      }

      return json({ jobId, url: checked.url, status: 'queued', createdAt: now, maxPages: requestedMaxPages, maxDepth: requestedMaxDepth, scope: 'same-origin' }, 202);
    }

    return json({ error: 'NOT_FOUND' }, 404);
  },

  async queue(batch, env) {
    if (!env.DB) {
      for (const message of batch.messages) message.retry({ delaySeconds: 60 });
      return;
    }

    for (const message of batch.messages) {
      await handleQueueMessage(message, env);
    }
  },
};
