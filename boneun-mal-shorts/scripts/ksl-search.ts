import { rel } from '../src/util/paths.js';
import { log } from '../src/util/log.js';
import { searchKslAllPages } from '../src/api/kcisa.js';
import { loadKslLibrary, verifyClipMetadata } from '../src/ksl/verifier.js';

// npm run ksl:search -- "커피"
// Normalised KCISA results, plus whether a verified clip exists for each hit.

async function main(): Promise<number> {
  const query = process.argv.slice(2).filter((a) => !a.startsWith('-')).join(' ');
  if (!query) {
    log.error('Usage: npm run ksl:search -- "커피"');
    return 2;
  }

  log.raw(`\nKCISA 한국수어 search — "${query}"\n`);
  const result = await searchKslAllPages(query, 50);

  if (result.status === 'KSL_DATA_UNAVAILABLE') {
    log.error(`KSL_DATA_UNAVAILABLE — ${result.reason}`);
    log.error(result.message);
    if (result.rawLogPath) log.error(`raw response: ${rel(result.rawLogPath)}`);
    log.blank();
    log.error('No results are invented in place of a failed lookup.');
    return 3;
  }
  if (result.status === 'EMPTY_RESULT') {
    log.warn(`KCISA returned no records for "${query}".`);
    return 1;
  }

  const clips = await loadKslLibrary(false);
  const verifiedWords = new Set(
    clips.filter((c) => verifyClipMetadata(c.metadata, c.file).usable).map((c) => c.word.replace(/\s+/g, '')),
  );

  log.ok(`${result.records.length} record(s) of ${result.totalCount}${result.fromCache ? ' (cache)' : ''}`);
  log.blank();
  result.records.forEach((r, i) => {
    const clip = verifiedWords.has(r.title.replace(/\s+/g, '')) ? 'VERIFIED CLIP' : 'NEEDS_KSL_RECORDING';
    log.raw(`${String(i + 1).padStart(3)}. ${r.title || '(untitled)'}   [${clip}]`);
    if (r.description) log.raw(`     ${r.description.slice(0, 120)}`);
    if (r.handshapeDescription) log.raw(`     손동작: ${r.handshapeDescription.slice(0, 120)}`);
    if (r.imageUrl) log.raw(`     image: ${r.imageUrl}`);
    if (r.videoUrl) log.raw(`     link:  ${r.videoUrl}`);
    log.raw(`     id: ${r.id} · ${r.source}/${r.sourceEndpoint}`);
  });
  log.blank();
  log.info('A record here proves the sign exists. Showing it still requires a human recording in assets/ksl/.');
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err: unknown) => {
    log.error((err as Error).message);
    process.exit(1);
  });
