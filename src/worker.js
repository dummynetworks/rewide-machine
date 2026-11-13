import { createRobotsPolicy } from './robots.js';

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({
        service: 'rewide-machine',
        bot: USER_AGENT,
        status: 'ok',
        runtime: 'cloudflare-workers',
        version: '0.1.0',
      });
    }

    if (url.pathname !== '/v1/crawl' || request.method !== 'POST') {
      return json({ error: 'NOT_FOUND' }, 404);
    }

    if (!env.DUMMYNET_TOKEN) {
      return json({ error: 'NOT_CONFIGURED', message: 'DUMMYNET_TOKEN secret is required.' }, 503);
    }

    if (!await authorized(request, env)) {
      return json({ error: 'UNAUTHORIZED' }, 401, { 'www-authenticate': 'Bearer' });
    }

    const declaredBodyLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredBodyLength) && declaredBodyLength > 4_096) {
      return json({ error: 'REQUEST_TOO_LARGE' }, 413);
    }

    let payload;
    try {
      const body = await request.text();
      if (body.length > 4_096) return json({ error: 'REQUEST_TOO_LARGE' }, 413);
      payload = JSON.parse(body);
    } catch {
      return json({ error: 'INVALID_JSON' }, 400);
    }

    if (!payload || typeof payload.url !== 'string' || payload.url.length > 2_048) {
      return json({ error: 'INVALID_REQUEST', message: 'Provide one URL string in the url field.' }, 400);
    }

    try {
      const result = await crawlOne(payload.url);
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
  },
};
