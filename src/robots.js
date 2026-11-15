import robotsParser from 'robots-parser';

export function createRobotsPolicy({
  robotsUrl,
  status,
  body = '',
  userAgent,
}) {
  if (
    Number.isInteger(status)
    && status >= 400
    && status < 500
    && status !== 429
  ) {
    return {
      mode: 'unavailable',
      allowed: () => true,
      crawlDelaySeconds: null,
      sitemaps: [],
    };
  }

  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw new Error(
      'ROBOTS_FETCH_TEMPORARY_FAILURE: robots.txt could not be retrieved (HTTP '
      + String(status) + ').',
    );
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
