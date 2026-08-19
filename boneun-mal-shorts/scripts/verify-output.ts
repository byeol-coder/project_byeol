import fs from 'node:fs';
import path from 'node:path';
import { P, rel } from '../src/util/paths.js';
import { log } from '../src/util/log.js';
import { readJson, writeJson, writeText } from '../src/util/json.js';
import { logVerification, renderVerificationReport, verifyOutput } from '../src/qa/verify.js';
import type { OutputManifest } from '../src/types.js';

// npm run verify                  → newest folder in output/
// npm run verify -- output/2026-08-19-커피
// Re-runs the full QA suite and rewrites verification-report.md.

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
    log.error('Nothing to verify: output/ has no rendered folder yet.');
    log.error('Run `npm run shorts` (or `npm run shorts:preview`) first.');
    return 2;
  }
  const manifestFile = path.join(dir, 'metadata.json');
  if (!fs.existsSync(manifestFile)) {
    log.error(`No metadata.json in ${rel(dir)} — cannot verify provenance without it.`);
    return 2;
  }

  log.raw(`\nVerifying ${rel(dir)}\n`);
  const manifest = readJson<OutputManifest>(manifestFile, null as never);
  const result = await verifyOutput({ dir, manifest });

  manifest.verification = result;
  manifest.publishReady = result.publishReady;
  writeJson(manifestFile, manifest);
  const report = path.join(dir, 'verification-report.md');
  writeText(report, renderVerificationReport(manifest, result));

  logVerification(result);
  log.blank();
  log.raw(`KSL Source: ${result.kslSource}`);
  log.raw(`KSL API Match: ${result.kslApiMatch}`);
  log.raw(`Verified Human Clip: ${result.verifiedHumanClip}`);
  log.raw(`PUBLISH_READY=${result.publishReady}`);
  log.raw(`report: ${rel(report)}\n`);
  return result.publishReady ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((err: unknown) => {
    log.error((err as Error).message);
    process.exit(1);
  });
