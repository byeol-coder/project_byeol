import { rel } from '../src/util/paths.js';
import { log } from '../src/util/log.js';
import { loadKslLibrary, verifyClipMetadata } from '../src/ksl/verifier.js';
import { loadTopics } from '../src/content/selectTopic.js';

// npm run ksl:library
// What can actually be published today, and what still needs recording.

async function main(): Promise<number> {
  const clips = await loadKslLibrary(true);
  log.raw('\nKSL clip library — assets/ksl/\n');

  if (clips.length === 0) {
    log.warn('empty. No sign can be shown until a real signer records one.');
  }
  for (const clip of clips) {
    const check = verifyClipMetadata(clip.metadata, clip.file);
    const size = clip.width && clip.height ? `${clip.width}×${clip.height}` : 'unknown size';
    const dur = clip.durationSeconds ? `${clip.durationSeconds.toFixed(1)}s` : 'unknown length';
    log.raw(`${check.usable ? '✅' : '❌'} ${clip.word.padEnd(12)} ${rel(clip.file)}  (${dur}, ${size})`);
    if (!check.usable) check.problems.forEach((p) => log.raw(`     · ${p}`));
  }

  const verified = new Set(
    clips.filter((c) => verifyClipMetadata(c.metadata, c.file).usable).map((c) => c.word.replace(/\s+/g, '')),
  );
  const { topics } = loadTopics();
  const needed = new Map<string, string[]>();
  for (const t of topics) {
    for (const w of t.kslWords) {
      if (verified.has(w.replace(/\s+/g, ''))) continue;
      needed.set(w, [...(needed.get(w) ?? []), t.topic]);
    }
  }

  log.raw('\nSigns still to record, by how many topics need them:\n');
  [...needed.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([word, usedBy]) => {
      log.raw(`  ${word.padEnd(12)} ${usedBy.length} topic(s): ${usedBy.slice(0, 4).join(', ')}`);
    });
  log.raw('');
  log.info('Record with a real signer, add the sidecar JSON, then the topic unblocks itself.');
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err: unknown) => {
    log.error((err as Error).message);
    process.exit(1);
  });
