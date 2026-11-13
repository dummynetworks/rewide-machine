import robotsParser from 'robots-parser';

const DENY_ALL = 'User-agent: *\nDisallow: /';

export function createRobotsPolicy({
  robotsUrl,
  status,
  body = '',
  userAgent,
}) {
  if (status === 404 || status === 410) {
    return {
      mode: 'unavailable',
      allowed: () => true,
      crawlDelaySeconds: null,
      sitemaps: [],
    };
  }

  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    const parser = robotsParser(robotsUrl, DENY_ALL);
    return {
      mode: 'blocked',
      allowed: (url) => parser.isAllowed(url, userAgent) === true,
      crawlDelaySeconds: null,
      sitemaps: [],
    };
  }

  const parser = robotsParser(robotsUrl, body);
  const crawlDelay = parser.getCrawlDelay(userAgent);

  return {
    mode: 'parsed',
    allowed: (url) => parser.isAllowed(url, userAgent) !== false,
    crawlDelaySeconds: Number.isFinite(crawlDelay) && crawlDelay > 0
      ? Math.min(crawlDelay, 60)
      : null,
    sitemaps: parser.getSitemaps().slice(0, 20),
  };
}
