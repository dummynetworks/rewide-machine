/**
 * Elements that are usually interface chrome, not the publisher's article body.
 * Keep this list conservative: it is applied to both the Worker and local CLI
 * extractors so their indexed text stays consistent.
 */
export const REMOVE_CONTENT_SELECTORS = Object.freeze([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
  'nav', 'footer', 'form', 'aside', '[hidden]', '[aria-hidden="true"]',
  '[role="navigation"]', '[role="complementary"]', '[role="contentinfo"]',
  '[role="menu"]', '[role="search"]',
  '[class*="sidebar"]', '[id*="sidebar"]',
  '[class*="related"]', '[id*="related"]',
  '[class*="recommended"]', '[id*="recommended"]',
  '[class*="recommendation"]', '[id*="recommendation"]',
  '[class*="trending"]', '[id*="trending"]',
  '[class*="popular"]', '[id*="popular"]',
  '[class*="most-read"]', '[id*="most-read"]',
  '[class*="more-articles"]', '[id*="more-articles"]',
  '[class*="more-stories"]', '[id*="more-stories"]',
  '[class*="suggested"]', '[id*="suggested"]',
  '[class*="read-more"]', '[id*="read-more"]',
]);

/**
 * Strong article-body markers. These identify the preferred content root;
 * they are not elements to delete.
 */
export const ARTICLE_BODY_SELECTORS = Object.freeze([
  '[itemprop="articleBody"]',
  '[class*="article-body"]', '[id*="article-body"]',
  '[class*="article-content"]', '[id*="article-content"]',
  '[class*="entry-content"]', '[id*="entry-content"]',
  '[class*="post-content"]', '[id*="post-content"]',
  '[class*="story-body"]', '[id*="story-body"]',
  '[class*="story-content"]', '[id*="story-content"]',
]);

/** HTMLRewriter needs explicit descendant selectors to collect a full root. */
export const ARTICLE_BODY_TEXT_SELECTORS = Object.freeze(
  ARTICLE_BODY_SELECTORS.flatMap((selector) => [selector, selector + ' *']),
);

/**
 * Prefer an article-specific root, then semantic article/main containers.
 * Full-body extraction remains the compatibility fallback for older markup.
 */
export function selectArticleText(candidates, maxLength = 100_000) {
  const limit = Number.isInteger(maxLength) && maxLength > 0
    ? maxLength
    : 100_000;

  for (const candidate of [
    candidates?.articleBody,
    candidates?.article,
    candidates?.main,
    candidates?.body,
  ]) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.replace(/\s+/g, ' ').trim();
    if (normalized) return normalized.slice(0, limit);
  }

  return '';
}
