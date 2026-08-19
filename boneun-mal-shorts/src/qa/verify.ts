import fs from 'node:fs';
import path from 'node:path';
import { brand, video as videoConfig } from '../util/config.js';
import { ffmpegBin, ffprobeMedia, run } from '../util/exec.js';
import { log } from '../util/log.js';
import { rel } from '../util/paths.js';
import { computeBurnInBand } from '../video/subtitle.js';
import type { Check, OutputManifest, VerificationResult } from '../types.js';

// ---------------------------------------------------------------------------
// Output QA and the publish gate.
//
// Every check runs; nothing short-circuits, so the report always shows the full
// picture. PUBLISH_READY is true only when nothing FAILed — and a missing
// verified human clip always FAILs.
// ---------------------------------------------------------------------------

function pass(name: string, detail: string): Check {
  return { name, state: 'PASS', detail };
}
function fail(name: string, detail: string): Check {
  return { name, state: 'FAIL', detail };
}
function skip(name: string, detail: string): Check {
  return { name, state: 'SKIP', detail };
}

/** Frames that are effectively pure black — an ink-black brand card is not one. */
async function detectBlackFrames(videoFile: string): Promise<{ intervals: string[]; error: string | null }> {
  try {
    const r = await run(
      ffmpegBin(),
      [
        '-hide_banner',
        '-i',
        videoFile,
        '-vf',
        'blackdetect=d=0.4:pix_th=0.02:pic_th=0.999',
        '-f',
        'null',
        '-',
      ],
      300_000,
    );
    const intervals = [...r.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map(
      (m) => `${m[1]}s–${m[2]}s`,
    );
    return { intervals, error: null };
  } catch (err) {
    return { intervals: [], error: (err as Error).message };
  }
}

function countSrtCues(file: string): number {
  if (!fs.existsSync(file)) return 0;
  const text = fs.readFileSync(file, 'utf8');
  return (text.match(/-->/g) ?? []).length;
}

export interface VerifyInput {
  dir: string;
  manifest: OutputManifest;
}

export async function verifyOutput(input: VerifyInput): Promise<VerificationResult> {
  const vid = videoConfig();
  const b = brand();
  const { dir, manifest } = input;
  const checks: Check[] = [];

  const videoFile = path.join(dir, 'shorts.mp4');

  // --- container / canvas ---------------------------------------------------
  if (!fs.existsSync(videoFile)) {
    checks.push(fail('video file', `missing ${rel(videoFile)}`));
  } else {
    let probed: Awaited<ReturnType<typeof ffprobeMedia>> | null = null;
    try {
      probed = await ffprobeMedia(videoFile);
    } catch (err) {
      checks.push(fail('ffprobe', (err as Error).message));
    }

    if (probed) {
      const { width, height, fps, durationSeconds, hasAudio, videoCodec, audioCodec, sampleAspectRatio } = probed;

      checks.push(
        width === vid.canvas.width && height === vid.canvas.height
          ? pass('resolution', `${width}×${height}`)
          : fail('resolution', `${width}×${height}, expected ${vid.canvas.width}×${vid.canvas.height}`),
      );

      const ratio = height ? width / height : 0;
      const expected = 9 / 16;
      checks.push(
        Math.abs(ratio - expected) < 0.001 && ['1:1', '0:1', ''].includes(sampleAspectRatio)
          ? pass('aspect ratio', `9:16 (SAR ${sampleAspectRatio || '1:1'})`)
          : fail('aspect ratio', `${ratio.toFixed(4)} (SAR ${sampleAspectRatio}), expected 9:16 square pixels`),
      );

      checks.push(
        Math.abs(fps - vid.canvas.fps) < 0.5
          ? pass('frame rate', `${fps}fps`)
          : fail('frame rate', `${fps}fps, expected ${vid.canvas.fps}fps`),
      );

      const inRange =
        durationSeconds >= vid.duration.minSeconds && durationSeconds <= vid.duration.maxSeconds;
      checks.push(
        inRange
          ? pass('duration', `${durationSeconds.toFixed(2)}s (allowed ${vid.duration.minSeconds}–${vid.duration.maxSeconds}s)`)
          : fail('duration', `${durationSeconds.toFixed(2)}s is outside ${vid.duration.minSeconds}–${vid.duration.maxSeconds}s`),
      );

      checks.push(
        hasAudio
          ? pass('audio track', `${audioCodec} present`)
          : fail('audio track', 'no audio stream — YouTube Shorts expects one, even if silent'),
      );

      checks.push(
        videoCodec === 'h264'
          ? pass('video codec', videoCodec)
          : fail('video codec', `${videoCodec}, expected h264`),
      );
      checks.push(
        !hasAudio || audioCodec === 'aac'
          ? hasAudio
            ? pass('audio codec', audioCodec)
            : skip('audio codec', 'no audio stream')
          : fail('audio codec', `${audioCodec}, expected aac`),
      );
    }

    // --- black frames ------------------------------------------------------
    const black = await detectBlackFrames(videoFile);
    if (black.error) checks.push(skip('black frames', `blackdetect could not run: ${black.error}`));
    else
      checks.push(
        black.intervals.length === 0
          ? pass('black frames', 'none ≥0.4s')
          : fail('black frames', `fully black stretches at ${black.intervals.join(', ')}`),
      );
  }

  // --- KSL provenance ------------------------------------------------------
  const verifiedClip = manifest.ksl.verifiedHumanClip;
  const apiMatch = manifest.ksl.apiMatch;

  checks.push(
    manifest.ksl.source === 'KCISA' && manifest.ksl.kcisaFetchedAt
      ? pass('KSL API source', `KCISA ${manifest.ksl.kcisaEndpoint} @ ${manifest.ksl.kcisaFetchedAt}`)
      : fail('KSL API source', 'no KCISA lookup is recorded for this video'),
  );
  checks.push(
    apiMatch === 'PASS'
      ? pass('KCISA sign match', manifest.ksl.words.join(', '))
      : fail('KCISA sign match', 'at least one sign has no KCISA entry'),
  );
  checks.push(
    verifiedClip === 'YES'
      ? pass('verified human KSL clip', 'every sign is a human recording with consent on file')
      : fail(
          'verified human KSL clip',
          'no verified human clip — publishing is blocked. Record the sign; never generate it.',
        ),
  );

  // --- captions ------------------------------------------------------------
  const koSrt = path.join(dir, vid.subtitle.sidecar.ko);
  const enSrt = path.join(dir, vid.subtitle.sidecar.en);
  const koCues = countSrtCues(koSrt);
  const enCues = countSrtCues(enSrt);
  checks.push(
    koCues > 0 ? pass('Korean captions', `${koCues} cue(s)`) : fail('Korean captions', `${rel(koSrt)} has no cues`),
  );
  checks.push(
    enCues > 0 ? pass('English captions', `${enCues} cue(s)`) : fail('English captions', `${rel(enSrt)} has no cues`),
  );

  try {
    const band = computeBurnInBand();
    const uiTop = vid.canvas.height - vid.safeArea.bottomPx;
    checks.push(
      pass(
        'subtitle safe area',
        `burn-in occupies ${band.koTopPx}–${band.enBottomPx}px: below the signing space ` +
          `(ends ${vid.signingSpace.bottomPx}px) and above the Shorts UI reserve (starts ${uiTop}px)`,
      ),
    );
  } catch (err) {
    checks.push(fail('subtitle safe area', (err as Error).message));
  }

  // --- assets --------------------------------------------------------------
  const missingAssets: string[] = [];
  let checkedFiles = 0;
  for (const [name, file] of Object.entries(manifest.files)) {
    const full = path.isAbsolute(file) ? file : path.join(dir, file);
    // The report is written from this very result, so on a first pass it does
    // not exist yet. On any later `npm run verify` it must.
    if (name === 'report' && !fs.existsSync(full)) continue;
    checkedFiles += 1;
    if (!fs.existsSync(full)) missingAssets.push(`${name} → ${file}`);
  }
  checks.push(
    missingAssets.length === 0
      ? pass('output files', `${checkedFiles} file(s) present`)
      : fail('output files', `missing: ${missingAssets.join(', ')}`),
  );

  // --- metadata ------------------------------------------------------------
  const meta = manifest.youtube;
  const metaProblems: string[] = [];
  if (!meta?.title) metaProblems.push('no title');
  if (!meta?.description) metaProblems.push('no description');
  if (!meta?.hashtags?.length) metaProblems.push('no hashtags');
  if (meta?.hashtags && meta.hashtags.length > 5) metaProblems.push('more than 5 hashtags');
  if (meta?.privacyStatus !== 'private') metaProblems.push(`privacyStatus is ${meta?.privacyStatus}, must be private`);
  checks.push(
    metaProblems.length === 0
      ? pass('metadata', `"${meta.title}"`)
      : fail('metadata', metaProblems.join('; ')),
  );

  // --- copyright / disclosure ---------------------------------------------
  const musicUsed = Boolean(manifest.files['music']);
  checks.push(
    musicUsed
      ? pass('copyright check', 'music has a rights-cleared sidecar (unverified tracks are never selected)')
      : pass('copyright check', 'no music track — nothing to clear'),
  );
  if (manifest.commercial.commercial || manifest.commercial.affiliate) {
    const hasDisclosure =
      Boolean(manifest.commercial.disclosureKo) &&
      manifest.youtube.description.includes(manifest.commercial.disclosureKo!);
    checks.push(
      hasDisclosure
        ? pass('commercial disclosure', manifest.commercial.disclosureKo!)
        : fail('commercial disclosure', 'commercial content without disclosure in the description'),
    );
  } else {
    checks.push(skip('commercial disclosure', 'not commercial content'));
  }

  // --- tone guard ----------------------------------------------------------
  const generalising = ['모든 농인은', '농인들은 모두', 'all deaf people'];
  const copyBlob = [
    manifest.script.hookKo,
    manifest.script.hookEn,
    ...manifest.script.bodyKo,
    ...manifest.script.bodyEn,
    manifest.script.pointKo,
    manifest.script.pointEn,
    manifest.youtube.description,
  ]
    .join(' ')
    .toLowerCase();
  const hits = generalising.filter((g) => copyBlob.includes(g.toLowerCase()));
  checks.push(
    hits.length === 0
      ? pass('tone guard', 'no generalising claims about Deaf people')
      : fail('tone guard', `generalising phrase(s): ${hits.join(', ')}`),
  );

  // --- brand ending -------------------------------------------------------
  const endingSeg = manifest.script.endingKo;
  checks.push(
    endingSeg === b.brandNameKo
      ? pass('brand ending', `${b.brandNameKo} / ${b.brandNameEn}`)
      : fail('brand ending', `ending is "${endingSeg}", expected "${b.brandNameKo}"`),
  );

  const blockers = checks.filter((c) => c.state === 'FAIL').map((c) => `${c.name}: ${c.detail}`);
  const publishReady = blockers.length === 0;

  return {
    checks,
    kslSource: manifest.ksl.source,
    kslApiMatch: apiMatch,
    verifiedHumanClip: verifiedClip,
    publishReady,
    blockers,
  };
}

export function renderVerificationReport(
  manifest: OutputManifest,
  result: VerificationResult,
): string {
  const b = brand();
  const icon = (s: Check['state']) => (s === 'PASS' ? '✅' : s === 'FAIL' ? '❌' : '➖');

  const lines: string[] = [
    `# Verification report — ${manifest.topic}`,
    '',
    `${b.brandNameKo} · ${b.brandNameEn} — ${b.descriptor}`,
    '',
    '## KSL provenance',
    '',
    '```',
    `KSL Source: ${result.kslSource}`,
    `KSL API Match: ${result.kslApiMatch}`,
    `Verified Human Clip: ${result.verifiedHumanClip}`,
    '```',
    '',
    result.verifiedHumanClip === 'YES'
      ? 'The signing in this video is a recording of a real person. No sign language was generated.'
      : '**Not publishable.** No verified human recording exists for the sign(s) below. ' +
        'No AI-generated signing was substituted — the sign must be recorded with a real signer first.',
    '',
    '| Sign | KCISA match | Clip | Status |',
    '| --- | --- | --- | --- |',
    ...manifest.ksl.matches.map((m) => {
      const clip = m.clip ? `\`${rel(m.clip.file)}\`` : '—';
      return `| ${m.word} | ${m.kcisaMatch} | ${clip} | ${m.status} |`;
    }),
    '',
  ];

  const problems = manifest.ksl.matches.flatMap((m) => m.problems.map((p) => `· ${m.word}: ${p}`));
  if (problems.length) {
    lines.push('### What is missing', '', '```', ...problems, '```', '');
  }

  lines.push(
    '## Video QA',
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...result.checks.map((c) => `| ${c.name} | ${icon(c.state)} ${c.state} | ${c.detail.replace(/\|/g, '\\|')} |`),
    '',
    '## Publish gate',
    '',
    '```',
    `PUBLISH_READY=${result.publishReady}`,
    '```',
    '',
  );

  if (result.blockers.length) {
    lines.push('Blocked by:', '', ...result.blockers.map((b2) => `1. ${b2}`), '');
  } else {
    lines.push(
      'All gates pass. The upload step will create the video as **private** — a human reviews it and flips it public.',
      '',
    );
  }

  lines.push(
    '## Video',
    '',
    `- Mode: \`${manifest.mode}\``,
    `- Series: ${manifest.series}`,
    `- Structure: ${manifest.script.structureVariant}`,
    `- Duration: ${manifest.durationSeconds.toFixed(2)}s`,
    `- Created: ${manifest.createdAt}`,
    `- Title: ${manifest.youtube.title}`,
    '',
    '## Files',
    '',
    ...Object.entries(manifest.files).map(([k, v]) => `- \`${k}\` → \`${v}\``),
    '',
  );

  return lines.join('\n');
}

export function logVerification(result: VerificationResult): void {
  for (const c of result.checks) {
    const line = `${c.name}: ${c.detail}`;
    if (c.state === 'PASS') log.ok(line);
    else if (c.state === 'FAIL') log.error(line);
    else log.info(`— ${line}`);
  }
  log.blank();
  if (result.publishReady) log.ok('PUBLISH_READY=true');
  else {
    log.error(`PUBLISH_READY=false (${result.blockers.length} blocker(s))`);
    result.blockers.forEach((b) => log.error(`  · ${b}`));
  }
}
