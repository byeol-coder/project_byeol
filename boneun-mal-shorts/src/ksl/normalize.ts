import { XMLParser } from 'fast-xml-parser';
import type { KslRecord } from '../types.js';

// ---------------------------------------------------------------------------
// KCISA response adapter.
//
// The live response shape is confirmed by running `npm run ksl:probe -- "커피"`,
// which saves the raw payload under .cache/kcisa-raw/. This adapter is written
// to be tolerant rather than clairvoyant: it indexes keys case- and
// separator-insensitively and tries a list of candidate names per field, and it
// reports which name it actually matched (`mappedFrom`) plus the full raw record
// so drift is visible instead of silent.
//
// If a real response uses names not listed here, add them to FIELD_CANDIDATES —
// do not guess a mapping and do not fabricate a value.
// ---------------------------------------------------------------------------

// Confirmed against a real getCTE01701 response on 2026-08-19 (see
// .cache/kcisa-raw/, npm run ksl:probe): `description` is always empty in this
// dataset; the real hand-motion text lives in `signDescription`. `subDescription`
// is NOT a text description — it is the actual sign-language video file URL
// (…_700X466.mp4). `referenceIdentifier` is a thumbnail image URL, not a content
// id; the real per-record id is the `origin_no` query param embedded in `url`
// (extracted separately in normalizeRecord, not via FIELD_CANDIDATES). `signImages`
// holds a comma-separated list of step images. Candidate lists below still list
// plausible alternates first for other KCISA operations that may use different
// field names — do not delete the fallbacks on the strength of one endpoint.
export const FIELD_CANDIDATES = {
  id: [
    'localId',
    'identifier',
    'id',
    'cid',
    'contentId',
    'seq',
    'rnum',
    'referenceIdentifier',
  ],
  title: ['title', 'alternativeTitle', 'name', 'subjectName', 'word', 'headWord'],
  description: ['description', 'content', 'contents', 'explain', 'meaning'],
  handshapeDescription: [
    'signDescription',
    'handShape',
    'handshape',
    'gesture',
    'motion',
    'howTo',
    'description2',
    'etc',
    'subDescription',
  ],
  imageUrl: ['signImages', 'imageObject', 'imageUrl', 'image', 'thumbnail', 'thumbnailUrl', 'photo'],
  videoUrl: [
    'subDescription',
    'videoUrl',
    'movieUrl',
    'mediaUrl',
    'signVideo',
    'clipUrl',
    'url',
    'link',
    'homepageUrl',
    'viewUrl',
  ],
  location: [
    'spatialCoverage',
    'location',
    'place',
    'address',
    'region',
    'collectionDb',
    'contributor',
  ],
} as const;

export type FieldName = keyof typeof FIELD_CANDIDATES;

/** lowercase + strip separators, so TITLE / title / Title / SUB_DESCRIPTION all match. */
function normKey(key: string): string {
  return key.toLowerCase().replace(/[\s_\-.]/g, '');
}

export interface ParsedPayload {
  kind: 'json' | 'xml';
  value: unknown;
}

export function parsePayload(body: string, contentType: string): ParsedPayload | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const looksXml = trimmed.startsWith('<');
  const saysJson = contentType.includes('json');

  if (!looksXml && (saysJson || trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      return { kind: 'json', value: JSON.parse(trimmed) };
    } catch {
      /* fall through to XML */
    }
  }
  if (looksXml) {
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@',
        trimValues: true,
        parseTagValue: false,
        cdataPropName: '__cdata',
      });
      return { kind: 'xml', value: parser.parse(trimmed) };
    } catch {
      return null;
    }
  }
  // Last resort: some gateways send JSON with a text/html content type.
  try {
    return { kind: 'json', value: JSON.parse(trimmed) };
  } catch {
    return null;
  }
}

export interface Envelope {
  resultCode: string | null;
  resultMsg: string | null;
  totalCount: number;
  pageNo: number;
  numOfRows: number;
  items: Array<Record<string, unknown>>;
  /** True when no item container could be located at all. */
  schemaUnrecognised: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Depth-first search for the first value whose key matches any candidate. */
function findByKey(root: unknown, candidates: string[], maxDepth = 8): unknown {
  const wanted = new Set(candidates.map(normKey));
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > maxDepth) return undefined;
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = walk(child, depth + 1);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    if (!isPlainObject(node)) return undefined;
    for (const [k, v] of Object.entries(node)) {
      if (wanted.has(normKey(k))) return v;
    }
    for (const v of Object.values(node)) {
      const hit = walk(v, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return walk(root, 0);
}

function toStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const cdata = (v as Record<string, unknown>)['__cdata'];
    if (typeof cdata === 'string') return cdata;
    const text = (v as Record<string, unknown>)['#text'];
    if (typeof text === 'string' || typeof text === 'number') return String(text);
    return null;
  }
  return String(v);
}

function toInt(v: unknown, fallback: number): number {
  const s = toStringOrNull(v);
  if (s === null) return fallback;
  const n = Number.parseInt(s.replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Locate the item container. Handles the common data.go.kr / KCISA envelope
 * (response.body.items.item[]) as well as a flat `{ items: [...] }`, a bare
 * array, and the single-record case where `item` is an object not an array.
 */
export function extractEnvelope(parsed: unknown): Envelope {
  const resultCode = toStringOrNull(
    findByKey(parsed, ['resultCode', 'returnReasonCode', 'code', 'errMsg']),
  );
  const resultMsg = toStringOrNull(
    findByKey(parsed, ['resultMsg', 'returnAuthMsg', 'message', 'msg', 'errorMessage']),
  );
  const totalCount = toInt(findByKey(parsed, ['totalCount', 'total', 'totalcnt', 'count']), 0);
  const pageNo = toInt(findByKey(parsed, ['pageNo', 'page', 'currentPage']), 1);
  const numOfRows = toInt(findByKey(parsed, ['numOfRows', 'rows', 'perPage']), 0);

  let items: Array<Record<string, unknown>> = [];
  let schemaUnrecognised = false;

  if (Array.isArray(parsed)) {
    items = parsed.filter(isPlainObject);
  } else {
    const container = findByKey(parsed, ['item', 'items', 'record', 'records', 'list', 'row']);
    if (Array.isArray(container)) {
      items = container.filter(isPlainObject);
    } else if (isPlainObject(container)) {
      // Either a single record, or a wrapper holding the real array one level down.
      const inner = findByKey(container, ['item', 'items', 'record', 'records', 'row'], 3);
      if (Array.isArray(inner)) items = inner.filter(isPlainObject);
      else if (isPlainObject(inner)) items = [inner];
      else items = [container];
    } else {
      schemaUnrecognised = true;
    }
  }

  return { resultCode, resultMsg, totalCount, pageNo, numOfRows, items, schemaUnrecognised };
}

/** Flatten one record into a normalised key → string map, keeping originals. */
function indexRecord(raw: Record<string, unknown>): Map<string, { key: string; value: string }> {
  const index = new Map<string, { key: string; value: string }>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 4 || !isPlainObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const s = toStringOrNull(v);
      const nk = normKey(k);
      if (s !== null && s !== '' && !index.has(nk)) index.set(nk, { key: k, value: s });
      if (isPlainObject(v)) walk(v, depth + 1);
    }
  };
  walk(raw, 0);
  return index;
}

export interface NormalizeOutcome {
  record: KslRecord;
  /** Target fields no candidate name matched. `title` missing = unusable record. */
  unmappedFields: FieldName[];
}

export function normalizeRecord(
  raw: Record<string, unknown>,
  endpoint: string,
  fallbackIndex: number,
): NormalizeOutcome {
  const index = indexRecord(raw);
  const mappedFrom: Record<string, string> = {};
  const unmappedFields: FieldName[] = [];

  const pick = (field: FieldName): string => {
    for (const candidate of FIELD_CANDIDATES[field]) {
      const hit = index.get(normKey(candidate));
      if (hit) {
        mappedFrom[field] = hit.key;
        return hit.value.trim();
      }
    }
    unmappedFields.push(field);
    return '';
  };

  const title = pick('title');
  const description = pick('description');
  const handshapeDescription = pick('handshapeDescription');
  let imageUrl = pick('imageUrl');
  const videoUrl = pick('videoUrl');
  const location = pick('location');
  let id = pick('id');

  // signImages is a comma-separated list of step images; take the first as
  // the representative one rather than passing the whole list through.
  if (imageUrl.includes(',')) imageUrl = imageUrl.split(',')[0]!.trim();

  // The real per-record identifier on this endpoint is embedded in the `url`
  // field as origin_no=NNNN, not any field FIELD_CANDIDATES can name directly.
  const urlField = index.get(normKey('url'));
  const originNo = urlField ? /origin_no=(\d+)/.exec(urlField.value)?.[1] : undefined;
  if (originNo) {
    id = `KCISA-${originNo}`;
    mappedFrom['id'] = 'url(origin_no)';
  } else if (!id) {
    id = title ? `title:${title}` : `index:${fallbackIndex}`;
  }

  return {
    record: {
      id,
      title,
      description,
      handshapeDescription: handshapeDescription === description ? '' : handshapeDescription,
      imageUrl,
      videoUrl,
      location,
      source: 'KCISA',
      sourceEndpoint: endpoint,
      mappedFrom,
      raw,
    },
    unmappedFields,
  };
}

/** True when a KCISA record actually names the word we are looking for. */
export function recordMatchesWord(record: KslRecord, word: string): boolean {
  const needle = word.replace(/\s+/g, '');
  if (!needle) return false;
  const haystacks = [record.title, record.description, record.handshapeDescription];
  return haystacks.some((h) => h && h.replace(/\s+/g, '').includes(needle));
}
