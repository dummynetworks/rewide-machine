import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export const TRANCO_API_URL = 'https://tranco-list.eu/api/lists/date/latest';
export const TRANCO_DOWNLOAD_BASE_URL = 'https://tranco-list.eu/download';
export const DEFAULT_SEED_LIMIT = 100;
export const MAX_SEED_LIMIT = 500;

function normalizeDomain(value, rowNumber) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  const ascii = domainToASCII(raw);

  if (
    !ascii
    || ascii.length > 253
    || !ascii.includes('.')
    || isIP(ascii)
    || ascii.includes('..')
    || ascii === 'localhost'
    || ['.localhost', '.local', '.internal', '.test'].some((suffix) => ascii.endsWith(suffix))
  ) {
    throw new Error('Invalid domain in Tranco row ' + rowNumber + '.');
  }

  const labels = ascii.split('.');
  if (labels.some((label) => (
    label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) {
    throw new Error('Invalid domain in Tranco row ' + rowNumber + '.');
  }

  return ascii;
}

export function parseTrancoCsv(csv, limit = DEFAULT_SEED_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEED_LIMIT) {
    throw new RangeError('limit must be an integer from 1 to ' + MAX_SEED_LIMIT + '.');
  }
  if (typeof csv !== 'string' || csv.length === 0) {
    throw new TypeError('Tranco CSV is empty.');
  }

  const entries = [];
  const seen = new Set();
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (let index = 0; index < lines.length && entries.length < limit; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    const separator = line.indexOf(',');
    if (separator < 1) {
      throw new Error('Malformed Tranco CSV row ' + (index + 1) + '.');
    }

    const rankText = line.slice(0, separator).trim();
    const domainText = line.slice(separator + 1).trim();
    if (!/^\d+$/.test(rankText)) {
      throw new Error('Invalid rank in Tranco CSV row ' + (index + 1) + '.');
    }

    const rank = Number(rankText);
    if (!Number.isSafeInteger(rank) || rank < 1) {
      throw new Error('Invalid rank in Tranco CSV row ' + (index + 1) + '.');
    }

    const domain = normalizeDomain(domainText, index + 1);
    if (seen.has(domain)) continue;
    seen.add(domain);

    entries.push({
      rank,
      domain,
      url: 'https://' + domain + '/',
    });
  }

  if (entries.length === 0) {
    throw new Error('Tranco CSV did not contain any valid domains.');
  }

  return entries;
}

async function readJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(label + ' did not return valid JSON.');
  }
}

export async function fetchTrancoSeeds({
  limit = DEFAULT_SEED_LIMIT,
  fetcher = globalThis.fetch,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEED_LIMIT) {
    throw new RangeError('limit must be an integer from 1 to ' + MAX_SEED_LIMIT + '.');
  }
  if (typeof fetcher !== 'function') {
    throw new TypeError('A fetch implementation is required.');
  }

  const metadataResponse = await fetcher(TRANCO_API_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!metadataResponse.ok) {
    throw new Error('Tranco metadata request failed with HTTP ' + metadataResponse.status + '.');
  }

  const metadata = await readJson(metadataResponse, 'Tranco metadata');
  const listId = String(metadata?.list_id || '');
  if (!/^[a-z0-9]{4,12}$/i.test(listId)) {
    throw new Error('Tranco metadata returned an invalid list ID.');
  }
  if (metadata.available !== true || metadata.failed === true) {
    throw new Error('Tranco list ' + listId + ' is not available yet.');
  }

  const downloadUrl = TRANCO_DOWNLOAD_BASE_URL + '/' + encodeURIComponent(listId) + '/' + limit;
  const listResponse = await fetcher(downloadUrl, {
    headers: { accept: 'text/csv,text/plain;q=0.9,*/*;q=0.1' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!listResponse.ok) {
    throw new Error('Tranco list download failed with HTTP ' + listResponse.status + '.');
  }

  const csv = await listResponse.text();
  const entries = parseTrancoCsv(csv, limit);
  return {
    source: 'Tranco',
    listId,
    listUrl: 'https://tranco-list.eu/list/' + encodeURIComponent(listId),
    downloadUrl,
    createdOn: metadata.created_on || null,
    fetchedAt: new Date().toISOString(),
    entries,
  };
}
