import fs from 'node:fs';
import path from 'node:path';
import { P } from '../util/paths.js';
import { env, envInt, maskSecret } from '../util/env.js';
import { log } from '../util/log.js';
import { readJson, writeJson } from '../util/json.js';
import { getWithRetry } from '../util/http.js';
import {
  extractEnvelope,
  normalizeRecord,
  parsePayload,
  recordMatchesWord,
} from '../ksl/normalize.js';
import type {
  KcisaFailureReason,
  KcisaSearchResult,
  KslRecord,
} from '../types.js';

// ---------------------------------------------------------------------------
// The only module that talks to the KCISA / 문화체육관광부 한국수어 OpenAPI.
//
// Hard rule: a failure here NEVER becomes a fabricated record. Every failure
// path returns status KSL_DATA_UNAVAILABLE with a reason, and callers stop.
// ---------------------------------------------------------------------------

const SUCCESS_CODES = new Set([
  '0000', '000', '00', '0', 'OK', 'SUCCESS', 'NORMAL SERVICE', 'NORMAL_SERVICE', '200',
]);

export interface KcisaConfig {
  baseUrl: string;
  operation: string;
  serviceKey: string;
  keyParam: string;
  queryParam: string;
  timeoutMs: number;
  maxRetries: number;
  rowsPerPage: number;
  cacheTtlHours: number;
}

export function kcisaConfig(): KcisaConfig {
  return {
    baseUrl: env('KCISA_BASE_URL', 'https://api.kcisa.kr/openapi/service/rest/meta13'),
    operation: env('KCISA_OPERATION', 'getCTE01701'),
    serviceKey: env('KCISA_SERVICE_KEY'),
    keyParam: env('KCISA_KEY_PARAM', 'serviceKey'),
    queryParam: env('KCISA_QUERY_PARAM', 'keyword'),
    timeoutMs: envInt('KCISA_TIMEOUT_MS', 15_000),
    maxRetries: envInt('KCISA_MAX_RETRIES', 3),
    rowsPerPage: envInt('KCISA_ROWS_PER_PAGE', 50),
    cacheTtlHours: envInt('KCISA_CACHE_TTL_HOURS', 168),
  };
}

export function buildUrl(
  cfg: KcisaConfig,
  query: string,
  pageNo: number,
  overrides: Record<string, string> = {},
): string {
  const url = new URL(`${cfg.baseUrl.replace(/\/+$/, '')}/${cfg.operation}`);
  url.searchParams.set(cfg.keyParam, cfg.serviceKey);
  url.searchParams.set('numOfRows', String(cfg.rowsPerPage));
  url.searchParams.set('pageNo', String(pageNo));
  if (query) url.searchParams.set(cfg.queryParam, query);
  for (const [k, v] of Object.entries(overrides)) url.searchParams.set(k, v);
  return url.toString();
}

/** URL safe to print: the key is replaced, never logged in full. */
export function redactUrl(url: string, serviceKey: string): string {
  if (!serviceKey) return url;
  return url.split(encodeURIComponent(serviceKey)).join('***KEY***').split(serviceKey).join('***KEY***');
}

// --- cache -----------------------------------------------------------------

interface CacheEntry {
  fetchedAt: string;
  query: string;
  pageNo: number;
  numOfRows: number;
  totalCount: number;
  endpoint: string;
  records: KslRecord[];
}

interface CacheFile {
  _comment?: string;
  _schemaVersion?: number;
  entries: Record<string, CacheEntry>;
}

const cacheKey = (cfg: KcisaConfig, query: string, pageNo: number): string =>
  `${cfg.operation}|${query}|${pageNo}|${cfg.rowsPerPage}`;

function readCache(): CacheFile {
  return readJson<CacheFile>(P.kslCache, { entries: {} });
}

function cacheLookup(cfg: KcisaConfig, query: string, pageNo: number): CacheEntry | null {
  const file = readCache();
  const entry = file.entries[cacheKey(cfg, query, pageNo)];
  if (!entry) return null;
  const ageHours = (Date.now() - Date.parse(entry.fetchedAt)) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours > cfg.cacheTtlHours) return null;
  return entry;
}

function cacheStore(cfg: KcisaConfig, entry: CacheEntry): void {
  const file = readCache();
  file._schemaVersion ??= 1;
  file._comment ??=
    'KCISA OpenAPI response cache. Only ever written from real API responses.';
  file.entries[cacheKey(cfg, entry.query, entry.pageNo)] = entry;
  writeJson(P.kslCache, file);
}

// --- raw response logging --------------------------------------------------

export function saveRawResponse(query: string, pageNo: number, body: string, meta: string): string {
  fs.mkdirSync(P.rawApiLog, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeQuery = (query || 'no-query').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 40);
  const file = path.join(P.rawApiLog, `${stamp}_${safeQuery}_p${pageNo}.txt`);
  fs.writeFileSync(file, `${meta}\n\n${body}`, 'utf8');
  return file;
}

// --- failure helper --------------------------------------------------------

function unavailable(
  reason: KcisaFailureReason,
  message: string,
  base: Partial<KcisaSearchResult>,
): KcisaSearchResult {
  return {
    status: 'KSL_DATA_UNAVAILABLE',
    reason,
    message,
    query: base.query ?? '',
    records: [],
    totalCount: 0,
    pageNo: base.pageNo ?? 1,
    numOfRows: 0,
    fromCache: false,
    rawLogPath: base.rawLogPath ?? null,
    httpStatus: base.httpStatus ?? 0,
    endpoint: base.endpoint ?? '',
    fetchedAt: new Date().toISOString(),
  };
}

function classifyTransportError(detail: string): KcisaFailureReason {
  const d = detail.toLowerCase();
  if (d.includes('timeout')) return 'TIMEOUT';
  if (
    d.includes('403') ||
    d.includes('407') ||
    d.includes('connect tunnel') ||
    d.includes('enotfound') ||
    d.includes('econnrefused') ||
    d.includes('eai_again') ||
    d.includes('certificate')
  ) {
    return 'NETWORK_BLOCKED';
  }
  return 'HTTP_ERROR';
}

// --- public API ------------------------------------------------------------

export interface SearchOptions {
  pageNo?: number;
  useCache?: boolean;
  /** Extra query params, used by the probe script to try parameter variants. */
  overrides?: Record<string, string>;
}

/**
 * One page of KCISA results for `query`, normalised.
 * Returns KSL_DATA_UNAVAILABLE on every failure — never a synthesised record.
 */
export async function searchKsl(query: string, opts: SearchOptions = {}): Promise<KcisaSearchResult> {
  const cfg = kcisaConfig();
  const pageNo = opts.pageNo ?? 1;
  const useCache = opts.useCache ?? true;
  const endpoint = cfg.operation;

  if (!cfg.serviceKey) {
    return unavailable(
      'MISSING_SERVICE_KEY',
      'KCISA_SERVICE_KEY is not set. Add it to .env (see .env.example). ' +
        'No sign language data is invented in its absence.',
      { query, pageNo, endpoint },
    );
  }

  if (useCache) {
    const hit = cacheLookup(cfg, query, pageNo);
    if (hit) {
      log.ok(`KCISA cache hit for "${query}" (${hit.records.length} records, fetched ${hit.fetchedAt})`);
      return {
        status: hit.records.length ? 'OK' : 'EMPTY_RESULT',
        reason: null,
        message: hit.records.length ? 'from cache' : 'cached empty result',
        query,
        records: hit.records,
        totalCount: hit.totalCount,
        pageNo: hit.pageNo,
        numOfRows: hit.numOfRows,
        fromCache: true,
        rawLogPath: null,
        httpStatus: 200,
        endpoint: hit.endpoint,
        fetchedAt: hit.fetchedAt,
      };
    }
  }

  const url = buildUrl(cfg, query, pageNo, opts.overrides);
  log.info(`GET ${redactUrl(url, cfg.serviceKey)}`);
  log.debug(`service key: ${maskSecret(cfg.serviceKey)}`);

  const res = await getWithRetry(url, {
    timeoutMs: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
  });

  if (res.transportError) {
    const reason = classifyTransportError(res.transportError);
    return unavailable(
      reason,
      `KCISA request never completed after ${res.attempts} attempt(s): ${res.transportError}` +
        (reason === 'NETWORK_BLOCKED'
          ? ' — api.kcisa.kr is unreachable from this network/proxy.'
          : ''),
      { query, pageNo, endpoint },
    );
  }

  const rawLogPath = saveRawResponse(
    query,
    pageNo,
    res.body,
    [
      `# url: ${redactUrl(res.url, cfg.serviceKey)}`,
      `# httpStatus: ${res.status}`,
      `# contentType: ${res.contentType}`,
      `# attempts: ${res.attempts}`,
      `# fetchedAt: ${new Date().toISOString()}`,
    ].join('\n'),
  );

  if (res.status === 429) {
    return unavailable('RATE_LIMITED', 'KCISA returned 429. Back off and retry later.', {
      query,
      pageNo,
      endpoint,
      rawLogPath,
      httpStatus: res.status,
    });
  }
  if (!res.ok) {
    return unavailable(
      'HTTP_ERROR',
      `KCISA returned HTTP ${res.status}. Raw body saved for inspection.`,
      { query, pageNo, endpoint, rawLogPath, httpStatus: res.status },
    );
  }

  const parsed = parsePayload(res.body, res.contentType);
  if (!parsed) {
    return unavailable(
      'UNPARSEABLE_RESPONSE',
      'KCISA response was neither valid JSON nor valid XML. Raw body saved for inspection.',
      { query, pageNo, endpoint, rawLogPath, httpStatus: res.status },
    );
  }

  const envelope = extractEnvelope(parsed.value);

  if (envelope.resultCode && !SUCCESS_CODES.has(envelope.resultCode.trim().toUpperCase())) {
    return unavailable(
      'API_ERROR_CODE',
      `KCISA reported resultCode=${envelope.resultCode}` +
        (envelope.resultMsg ? ` (${envelope.resultMsg})` : '') +
        '. Common causes: unregistered/expired service key, wrong operation name, quota exceeded.',
      { query, pageNo, endpoint, rawLogPath, httpStatus: res.status },
    );
  }

  if (envelope.schemaUnrecognised) {
    return unavailable(
      'SCHEMA_UNRECOGNISED',
      'Could not locate an item container in the KCISA response. Inspect the saved raw ' +
        'payload and extend src/ksl/normalize.ts — do not guess a mapping.',
      { query, pageNo, endpoint, rawLogPath, httpStatus: res.status },
    );
  }

  const records: KslRecord[] = [];
  const unmappedTitleCount = { n: 0 };
  envelope.items.forEach((raw, i) => {
    const { record, unmappedFields } = normalizeRecord(raw, endpoint, i);
    if (unmappedFields.includes('title')) unmappedTitleCount.n += 1;
    records.push(record);
  });

  if (records.length > 0 && unmappedTitleCount.n === records.length) {
    return unavailable(
      'SCHEMA_UNRECOGNISED',
      `Found ${records.length} item(s) but no recognisable title field. Inspect ${rawLogPath} ` +
        'and add the real field name to FIELD_CANDIDATES in src/ksl/normalize.ts.',
      { query, pageNo, endpoint, rawLogPath, httpStatus: res.status },
    );
  }

  const fetchedAt = new Date().toISOString();
  const numOfRows = envelope.numOfRows || records.length;
  const totalCount = envelope.totalCount || records.length;

  cacheStore(cfg, { fetchedAt, query, pageNo, numOfRows, totalCount, endpoint, records });

  return {
    status: records.length ? 'OK' : 'EMPTY_RESULT',
    reason: null,
    message: records.length
      ? `${records.length} record(s) of ${totalCount}`
      : `KCISA returned no records for "${query}".`,
    query,
    records,
    totalCount,
    pageNo,
    numOfRows,
    fromCache: false,
    rawLogPath,
    httpStatus: res.status,
    endpoint,
    fetchedAt,
  };
}

/**
 * Walk pages and return everything the API hands back, unfiltered.
 * Kept for callers that genuinely want a raw listing (e.g. browsing).
 * NOTE: on getCTE01701, this is NOT a keyword search — see scanKslByWord.
 */
export async function searchKslAllPages(
  query: string,
  limit = 100,
): Promise<KcisaSearchResult> {
  const first = await searchKsl(query, { pageNo: 1 });
  if (first.status === 'KSL_DATA_UNAVAILABLE') return first;

  const all = [...first.records];
  const rows = first.numOfRows || kcisaConfig().rowsPerPage;
  const maxPage = rows > 0 ? Math.ceil(Math.min(limit, first.totalCount) / rows) : 1;

  for (let page = 2; page <= maxPage && all.length < limit; page += 1) {
    const next = await searchKsl(query, { pageNo: page });
    if (next.status === 'KSL_DATA_UNAVAILABLE') {
      log.warn(`pagination stopped at page ${page}: ${next.message}`);
      break;
    }
    if (!next.records.length) break;
    all.push(...next.records);
  }

  return { ...first, records: all.slice(0, limit) };
}

export interface ScanOptions {
  /** Safety ceiling on how many records to pull across pages before giving up. */
  maxRecordsScanned?: number;
}

/**
 * Confirmed against a real response (2026-08-19, see .cache/kcisa-raw/): none of
 * `keyword` / `srchKwd` / `searchWord` / `title` / `query` actually filter this
 * operation — every one returns the identical unfiltered page 1 and the same
 * totalCount regardless of the search text. So this endpoint is list-only, and
 * matching a word means paging through the listing and filtering client-side.
 *
 * Pages are still requested with the query text attached (harmless if ignored,
 * and correct the day KCISA's server-side filtering starts working), and each
 * page is cached individually by searchKsl, so a repeated scan for a common
 * word is fast after the first run. The scan stops as soon as it finds a match
 * — most words will resolve in the first page or two — and gives up only after
 * maxRecordsScanned (default 4000, comfortably above this endpoint's ~3750
 * total records) with nothing found.
 */
export async function scanKslByWord(word: string, opts: ScanOptions = {}): Promise<KcisaSearchResult> {
  const cfg = kcisaConfig();
  const maxRecords = opts.maxRecordsScanned ?? envInt('KCISA_MAX_SCAN_RECORDS', 4000);
  const rows = Math.max(1, cfg.rowsPerPage);
  const maxPages = Math.max(1, Math.ceil(maxRecords / rows));

  let scanned = 0;
  let totalCount = 0;
  const matches: KslRecord[] = [];
  let last: KcisaSearchResult | null = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const result = await searchKsl(word, { pageNo: page });
    if (result.status === 'KSL_DATA_UNAVAILABLE') return result;
    last = result;
    totalCount = result.totalCount || totalCount;
    scanned += result.records.length;
    matches.push(...result.records.filter((r) => recordMatchesWord(r, word)));
    if (matches.length > 0) break;
    if (result.records.length < rows) break; // ran out of pages
    if (totalCount > 0 && scanned >= totalCount) break;
  }

  const base = last ?? {
    status: 'EMPTY_RESULT' as const,
    reason: null,
    query: word,
    records: [],
    totalCount: 0,
    pageNo: 1,
    numOfRows: rows,
    fromCache: false,
    rawLogPath: null,
    httpStatus: 0,
    endpoint: cfg.operation,
    fetchedAt: new Date().toISOString(),
    message: '',
  };

  return {
    ...base,
    status: matches.length ? 'OK' : 'EMPTY_RESULT',
    message: matches.length
      ? `${matches.length} match(es) for "${word}" after scanning ${scanned} record(s) ` +
        '(server-side keyword search is not functional on this endpoint; matched client-side)'
      : `No record titled "${word}" found after scanning ${scanned} of ${totalCount || 'unknown'} record(s).`,
    records: matches,
    query: word,
  };
}

/**
 * The authoritative check: does KCISA actually know this word as a KSL entry?
 * A hit here is what allows the word into a script at all.
 */
export async function lookupWord(
  word: string,
): Promise<{ result: KcisaSearchResult; exact: KslRecord | null }> {
  const result = await scanKslByWord(word);
  if (result.status !== 'OK') return { result, exact: null };
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const exact =
    result.records.find((r) => norm(r.title) === norm(word)) ??
    result.records.find((r) => recordMatchesWord(r, word)) ??
    null;
  return { result, exact };
}
