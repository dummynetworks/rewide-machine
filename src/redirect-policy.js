function withoutWww(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * Root jobs may follow HTTP→HTTPS and apex↔www redirects.
 * Other hosts remain out of scope; child pages must stay on the final exact Origin.
 */
export function isAllowedCrawlRedirect(targetUrl, allowedOrigin, {
  allowRootWwwAlias = false,
} = {}) {
  if (!allowedOrigin) return true;

  let allowed;
  let target;
  try {
    allowed = new URL(allowedOrigin);
    target = new URL(targetUrl);
  } catch {
    return false;
  }

  if (target.origin === allowed.origin) return true;
  if (!allowRootWwwAlias) return false;

  // Never follow an HTTPS seed down to HTTP.
  if (allowed.protocol === 'https:' && target.protocol !== 'https:') return false;

  return withoutWww(target.hostname) === withoutWww(allowed.hostname);
}
