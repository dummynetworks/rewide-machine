import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDocument, extractSitemapLocations } from '../src/extract.js';

test('extracts page metadata and readable text while respecting directives', () => {
  const html = `<!doctype html>
    <html lang="en">
      <head>
        <title>Example title</title>
        <meta name="description" content="A short description">
        <meta name="robots" content="noindex">
        <link rel="canonical" href="/canonical">
      </head>
      <body>
        <nav>Navigation must be removed</nav>
        <main>
          <h1>Hello web</h1>
          <p>Readable <strong>page</strong> content.</p>
          <a href="/about">About</a>
          <a href="/private" rel="nofollow">Private link</a>
          <a href="javascript:void(0)">Unsafe link</a>
        </main>
        <script>secretScript()</script>
      </body>
    </html>`;

  const document = extractDocument(
    html,
    'https://example.com/',
    new Headers(),
    { maxTextLength: 1000, maxLinksPerPage: 20 },
  );

  assert.equal(document.title, 'Example title');
  assert.equal(document.description, 'A short description');
  assert.equal(document.canonicalUrl, 'https://example.com/canonical');
  assert.equal(document.language, 'en');
  assert.match(document.text, /Hello web/);
  assert.doesNotMatch(document.text, /Navigation must be removed|secretScript/);
  assert.deepEqual(document.links, ['https://example.com/about']);
  assert.equal(document.noIndex, true);
  assert.equal(document.indexable, false);
});

test('reads X-Robots-Tag directives', () => {
  const document = extractDocument(
    '<html><body><p>Content</p></body></html>',
    'https://example.com/',
    new Headers({ 'x-robots-tag': 'rewidebot: noindex, nofollow' }),
  );

  assert.equal(document.noIndex, true);
  assert.equal(document.noFollow, true);
});

test('extracts sitemap page URLs and nested sitemap URLs', () => {
  const xml = `<?xml version="1.0"?>
    <sitemapindex>
      <sitemap><loc>https://example.com/nested.xml</loc></sitemap>
    </sitemapindex>`;
  const result = extractSitemapLocations(xml, 'https://example.com/sitemap.xml');

  assert.deepEqual(result.pages, []);
  assert.deepEqual(result.sitemaps, ['https://example.com/nested.xml']);
});
