import { rel } from '../src/util/paths.js';
import { log } from '../src/util/log.js';
import { getWithRetry } from '../src/util/http.js';
import { buildUrl, kcisaConfig, redactUrl, saveRawResponse } from '../src/api/kcisa.js';
import { FIELD_CANDIDATES, extractEnvelope, normalizeRecord, parsePayload } from '../src/ksl/normalize.js';

// ---------------------------------------------------------------------------
// Schema probe.
//
// The adapter in src/ksl/normalize.ts is written against candidate field names,
// not against a guessed schema. This script fetches the RAW response, saves it,
// and prints the real key names next to what the adapter mapped — so mapping is
// confirmed from evidence instead of assumed.
//
//   npm run ksl:probe -- "커피"
//
// It also tries alternative search-parameter names, because KCISA operations
// differ in whether they take `keyword`, `srchKwd`, `title`, …
// ---------------------------------------------------------------------------

const PARAM_VARIANTS = ['keyword', 'srchKwd', 'searchWord', 'title', 'query'];

async function probeOne(query: string, paramName: string): Promise<number> {
  const cfg = { ...kcisaConfig(), queryParam: paramName };
  const url = buildUrl(cfg, query, 1);
  log.raw(`\n── ${paramName} ─────────────────────────────`);
  log.info(`GET ${redactUrl(url, cfg.serviceKey)}`);

  const res = await getWithRetry(url, { timeoutMs: cfg.timeoutMs, maxRetries: 1 });
  if (res.transportError) {
    log.error(`no response: ${res.transportError}`);
    return 0;
  }
  const raw = saveRawResponse(
    `${query}-${paramName}`,
    1,
    res.body,
    `# url: ${redactUrl(url, cfg.serviceKey)}\n# httpStatus: ${res.status}\n# contentType: ${res.contentType}`,
  );
  log.info(`HTTP ${res.status} · ${res.contentType || 'no content-type'} · ${res.body.length} bytes`);
  log.info(`raw saved: ${rel(raw)}`);

  const parsed = parsePayload(res.body, res.contentType);
  if (!parsed) {
    log.error('response is neither valid JSON nor valid XML — open the saved file');
    log.raw(res.body.slice(0, 600));
    return 0;
  }
  log.ok(`parsed as ${parsed.kind}`);

  const env = extractEnvelope(parsed.value);
  log.info(
    `resultCode=${env.resultCode ?? '—'} resultMsg=${env.resultMsg ?? '—'} ` +
      `totalCount=${env.totalCount} items=${env.items.length}`,
  );
  if (env.schemaUnrecognised) {
    log.error('no item container found. Top-level shape:');
    log.raw(JSON.stringify(parsed.value, null, 2).slice(0, 1500));
    return 0;
  }
  if (env.items.length === 0) {
    log.warn('parsed fine but returned 0 items for this parameter name');
    return 0;
  }

  const first = env.items[0]!;
  log.raw('\nActual field names in the first record:');
  for (const [k, v] of Object.entries(first)) {
    const value = typeof v === 'object' ? JSON.stringify(v) : String(v);
    log.raw(`  ${k.padEnd(28)} ${value.slice(0, 70)}`);
  }

  const { record, unmappedFields } = normalizeRecord(first, kcisaConfig().operation, 0);
  log.raw('\nAdapter mapping:');
  for (const field of Object.keys(FIELD_CANDIDATES)) {
    const from = record.mappedFrom[field];
    const value = String((record as unknown as Record<string, unknown>)[field] ?? '');
    log.raw(`  ${field.padEnd(22)} ← ${(from ?? '(unmapped)').padEnd(24)} ${value.slice(0, 50)}`);
  }
  if (unmappedFields.length) {
    log.warn(
      `unmapped: ${unmappedFields.join(', ')} — if the real names are in the list above, ` +
        'add them to FIELD_CANDIDATES in src/ksl/normalize.ts',
    );
  }
  return env.items.length;
}

async function main(): Promise<number> {
  const query = process.argv.slice(2).filter((a) => !a.startsWith('-')).join(' ') || '커피';
  const cfg = kcisaConfig();

  log.raw(`\nKCISA schema probe — query "${query}"`);
  log.raw(`endpoint: ${cfg.baseUrl}/${cfg.operation}\n`);

  if (!cfg.serviceKey) {
    log.error('KCISA_SERVICE_KEY is not set.');
    log.error('  cp .env.example .env   then paste the key into KCISA_SERVICE_KEY');
    log.error('Nothing is probed without it, and no sample data is invented in its place.');
    return 2;
  }

  const only = process.argv.includes('--param')
    ? [process.argv[process.argv.indexOf('--param') + 1]!]
    : PARAM_VARIANTS;

  let best = '';
  let bestCount = 0;
  for (const param of only) {
    const count = await probeOne(query, param);
    if (count > bestCount) {
      bestCount = count;
      best = param;
    }
  }

  log.raw('\n─────────────────────────────────────────');
  if (bestCount > 0) {
    log.ok(`"${best}" returned ${bestCount} item(s) — set KCISA_QUERY_PARAM=${best} in .env`);
  } else {
    log.warn('no parameter variant returned items. Check the key, the operation name, and the saved raw files.');
  }
  return bestCount > 0 ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((err: unknown) => {
    log.error((err as Error).message);
    process.exit(1);
  });
