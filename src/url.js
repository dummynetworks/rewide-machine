import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.test',
];

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c] = parts;

  return (
    a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
  );
}

function isPrivateIPv6(address) {
  const value = address.toLowerCase().split('%')[0];

  if (value === '::' || value === '::1') return true;
  if (value.startsWith('::ffff:')) return true;
  if (value.startsWith('2001:db8:')) return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(value) || value.startsWith('ff')) return true;

  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  return false;
}

export function normalizeUrl(input, baseUrl) {
  try {
    const url = baseUrl ? new URL(input, baseUrl) : new URL(input);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!hostname) return null;
    if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return null;
    if (hostname === 'localhost') return null;

    const ipVersion = isIP(hostname);
    if (ipVersion === 4 && isPrivateIPv4(hostname)) return null;
    if (ipVersion === 6 && isPrivateIPv6(hostname)) return null;

    if (url.port && url.port !== '80' && url.port !== '443') return null;

    if (ipVersion === 0) url.hostname = hostname;
    url.hash = '';

    return url.href;
  } catch {
    return null;
  }
}

export function originOf(input) {
  const normalized = normalizeUrl(input);
  return normalized ? new URL(normalized).origin : null;
}

export async function assertPublicDestination(input, lookupFn = lookup) {
  const normalized = normalizeUrl(input);
  if (!normalized) {
    throw new TypeError('Target must be a public HTTP or HTTPS URL on port 80 or 443.');
  }

  const hostname = new URL(normalized).hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return normalized;

  let records;
  try {
    records = await lookupFn(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve crawler target: ${hostname}`);
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`No public address found for crawler target: ${hostname}`);
  }

  if (records.some((record) => {
    const version = isIP(record.address);
    return version === 4
      ? isPrivateIPv4(record.address)
      : version === 6 && isPrivateIPv6(record.address);
  })) {
    throw new Error(`Crawler target resolves to a non-public address: ${hostname}`);
  }

  return normalized;
}

export function isPublicIpAddress(address) {
  const version = isIP(address);
  if (version === 4) return !isPrivateIPv4(address);
  if (version === 6) return !isPrivateIPv6(address);
  return false;
}
