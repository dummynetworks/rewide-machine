export function selectCrawlLinks(links, {
  rootUrl,
  currentUrl,
  depth,
  maxDepth,
  limit = 50,
}) {
  if (!Array.isArray(links) || depth >= maxDepth || limit <= 0) return [];

  let rootOrigin;
  try {
    rootOrigin = new URL(rootUrl).origin;
  } catch {
    return [];
  }

  const seen = new Set([currentUrl]);
  const selected = [];

  for (const candidate of links) {
    if (typeof candidate !== 'string' || seen.has(candidate)) continue;

    try {
      const url = new URL(candidate);
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:')
        || url.origin !== rootOrigin
        || url.username
        || url.password
      ) {
        continue;
      }

      const normalized = url.href;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      selected.push({
        url: normalized,
        depth: depth + 1,
        parentUrl: currentUrl,
      });

      if (selected.length >= limit) break;
    } catch {
      // Ignore malformed links; the page itself can still be stored.
    }
  }

  return selected;
}
