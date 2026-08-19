import fs from 'node:fs';
import path from 'node:path';
import { P, rel } from '../src/util/paths.js';
import { log } from '../src/util/log.js';
import { readJson, writeJson } from '../src/util/json.js';
import { uploadToYoutube } from '../src/youtube/upload.js';
import type { OutputManifest } from '../src/types.js';

// npm run youtube:upload -- output/2026-08-19-커피
// Uploads as PRIVATE, only when the publish gate is green.

function newestOutputDir(): string | null {
  if (!fs.existsSync(P.output)) return null;
  const dirs = fs
    .readdirSync(P.output)
    .map((d) => path.join(P.output, d))
    .filter((d) => fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'metadata.json')))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

async function main(): Promise<number> {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const dir = arg ? path.resolve(arg) : newestOutputDir();
  if (!dir) {
    log.error('Nothing to upload: output/ is empty.');
    return 2;
  }
  const manifestFile = path.join(dir, 'metadata.json');
  if (!fs.existsSync(manifestFile)) {
    log.error(`No metadata.json in ${rel(dir)}.`);
    return 2;
  }

  const manifest = readJson<OutputManifest>(manifestFile, null as never);
  log.raw(`\nPublishing ${rel(dir)} — "${manifest.youtube.title}"\n`);
  log.raw(`KSL Source: ${manifest.ksl.source}`);
  log.raw(`KSL API Match: ${manifest.ksl.apiMatch}`);
  log.raw(`Verified Human Clip: ${manifest.ksl.verifiedHumanClip}`);
  log.raw(`PUBLISH_READY=${manifest.publishReady}\n`);

  const result = await uploadToYoutube({ dir, manifest });

  writeJson(manifestFile, {
    ...manifest,
    youtubeUpload: {
      videoId: result.videoId,
      uploadedAt: new Date().toISOString(),
      privacyStatus: 'private',
      captionsUploaded: result.captionsUploaded,
      thumbnailSet: result.thumbnailSet,
    },
  });

  log.blank();
  log.raw(`▶ ${result.studioUrl}`);
  log.raw(`  ${result.watchUrl}  (private until you change it)`);
  log.raw('\nReview it yourself before making it public. Nothing here flips that switch for you.\n');
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err: unknown) => {
    log.blank();
    log.error((err as Error).message);
    process.exit(1);
  });
