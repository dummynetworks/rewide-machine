import * as cheerio from 'cheerio';
import { normalizeUrl } from './url.js';

const REMOVE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'nav',
  'footer',
  'form',
  'aside',
  '[hidden]',
  '[aria-hidden="true"]',
];

function directiveSet(value) {
  return new Set(
    String(value ?? '')
      .toLowerCase()
      .replace(/^[^:]+:\s*/, '')
      .split(/[;,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function extractDocument(input, pageUrl, headers = new Headers(), options = {}) {
  const maxTextLength = options.maxTextLength ?? 100_000;
  const maxLinks = options.maxLinksPerPage ?? 500;
  const $ = Buffer.isBuffer(input)
    ? cheerio.loadBuffer(input)
    : cheerio.load(String(input));

  const title = (
    $('title').first().text()
    || $('meta[property="og:title"]').attr('content')
    || ''
  ).replace(/\s+/g, ' ').trim().slice(0, 500);

  const description = (
    $('meta[name="description"]').attr('content')
    || $('meta[property="og:description"]').attr('content')
    || ''
  ).replace(/\s+/g, ' ').trim().slice(0, 2_000);

  const canonicalHref = $('link[rel~="canonical"]').first().attr('href');
  const canonicalUrl = canonicalHref
    ? normalizeUrl(canonicalHref, pageUrl)
    : null;

  const language = ($('html').attr('lang') || '').trim().slice(0, 35) || null;
  const metaRobots = [
    $('meta[name="robots"]').attr('content'),
    $('meta[name="rewidebot"]').attr('content'),
  ].filter(Boolean).join(' ');
  const headerRobots = headers.get('x-robots-tag') ?? '';
  const directives = directiveSet(`${metaRobots} ${headerRobots}`);

  const noIndex = directives.has('noindex') || directives.has('none');
  const noFollow = directives.has('nofollow') || directives.has('none');

  for (const selector of REMOVE_SELECTORS) $(selector).remove();

  const text = ($('body').text() || $.root().text())
    .replace(/[\t\n\r ]+/g, ' ')
    .trim()
    .slice(0, maxTextLength);

  const links = [];
  const seen = new Set();

  $('a[href]').each((_, element) => {
    if (links.length >= maxLinks) return false;

    const rel = String($(element).attr('rel') ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('nofollow')) return;

    const normalized = normalizeUrl($(element).attr('href'), pageUrl);
    if (!normalized || normalized === pageUrl || seen.has(normalized)) return;

    seen.add(normalized);
    links.push(normalized);
  });

  return {
    url: pageUrl,
    title,
    description,
    canonicalUrl,
    language,
    text,
    links,
    noIndex,
    noFollow,
    indexable: !noIndex,
  };
}

export function extractSitemapLocations(xml, baseUrl, limit = 10_000) {
  const $ = cheerio.load(String(xml), { xmlMode: true });
  const pages = [];
  const sitemaps = [];

  $('loc').each((_, element) => {
    const location = $(element).text().trim();
    const normalized = normalizeUrl(location, baseUrl);
    if (!normalized) return;

    const parentTag = String($(element).parent().get(0)?.tagName ?? '').toLowerCase();
    const target = parentTag === 'sitemap' ? sitemaps : pages;
    if (target.length < limit && !target.includes(normalized)) {
      target.push(normalized);
    }
  });

  return { pages, sitemaps };
}
