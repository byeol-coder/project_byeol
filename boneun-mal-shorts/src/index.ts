import fs from 'node:fs';
import path from 'node:path';
import { P, rel } from './util/paths.js';
import { brand, koreanFontFileOrNull, video as videoConfig } from './util/config.js';
import { log } from './util/log.js';
import { writeJson, writeText } from './util/json.js';
import {
  checkRequiredFilters,
  ffmpegBin,
  ffprobeBin,
  missingFilterHelp,
  toolAvailable,
} from './util/exec.js';
import { appendHistory, markTopicUsed, selectTopic } from './content/selectTopic.js';
import { generateContent, scriptToText } from './content/generateContent.js';
import { matchKslWords, verifiedWordsAvailable } from './ksl/matcher.js';
import { kcisaConfig } from './api/kcisa.js';
import { buildTimeline } from './video/timeline.js';
import { buildAss, buildSrt, timelineToCues } from './video/subtitle.js';
import { renderShort } from './video/renderShort.js';
import { buildMetadata } from './youtube/metadata.js';
import { logVerification, renderVerificationReport, verifyOutput } from './qa/verify.js';
import { SERIES_NAMES, type OutputManifest, type SeriesName } from './types.js';

// ---------------------------------------------------------------------------
// The pipeline, in the one order that keeps sign language honest:
//   API 확인 → KSL 확인 → 소재 선정 → 대본 → 영상 → 자막 → QA
// ---------------------------------------------------------------------------

interface Args {
  topic?: string;
  series?: SeriesName;
  random: boolean;
  preview: boolean;
  force: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { random: false, preview: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--topic' || a === '-t') args.topic = argv[++i];
    else if (a === '--series' || a === '-s') {
      const value = argv[++i] ?? '';
      const match = SERIES_NAMES.find((s) => s.toLowerCase() === value.toLowerCase());
      if (!match) throw new Error(`Unknown series "${value}". One of: ${SERIES_NAMES.join(', ')}`);
      args.series = match;
    } else if (a === '--random') args.random = true;
    else if (a === '--preview') args.preview = true;
    else if (a === '--force') args.force = true;
    else if (a.startsWith('--topic=')) args.topic = a.slice('--topic='.length);
    else if (a.startsWith('--series=')) {
      const value = a.slice('--series='.length);
      const match = SERIES_NAMES.find((s) => s.toLowerCase() === value.toLowerCase());
      if (!match) throw new Error(`Unknown series "${value}". One of: ${SERIES_NAMES.join(', ')}`);
      args.series = match;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else if (a.startsWith('-')) {
      throw new Error(`Unknown option "${a}". Try --help.`);
    } else if (!args.topic) args.topic = a;
  }
  return args;
}

function printUsage(): void {
  const b = brand();
  log.raw(`${b.brandNameKo} / ${b.brandNameEn} — ${b.descriptor}

Usage:
  npm run shorts                        pick a topic by rotation and render
  npm run shorts -- --topic "커피"       render a specific topic
  npm run shorts -- --series K-SIGN     restrict to one series
  npm run shorts:random                 weighted-random topic
  npm run shorts:preview                render with placeholders when a verified clip is missing
  npm run shorts -- --force             ignore rotation blocks

A render is only produced when the sign is confirmed by KCISA and backed by a
verified human recording. Otherwise the run stops, or --preview leaves a
placeholder. Sign language is never generated.`);
}

function slugify(topic: string, date: string): string {
  const cleaned = topic
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40);
  return `${date}-${cleaned || 'untitled'}`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const mode: 'render' | 'preview' = args.preview ? 'preview' : 'render';
  const b = brand();
  const vid = videoConfig();

  log.raw(`\n${b.brandNameKo} · ${b.brandNameEn} — ${b.descriptor}`);
  log.raw(`mode: ${mode}\n`);
  log.plan(9);

  // --- [1] environment -----------------------------------------------------
  log.step('Checking environment...');
  const cfg = kcisaConfig();
  const haveFfmpeg = await toolAvailable(ffmpegBin());
  const haveFfprobe = await toolAvailable(ffprobeBin());
  if (!haveFfmpeg || !haveFfprobe) {
    log.error(
      `ffmpeg/ffprobe not found (ffmpeg: ${haveFfmpeg ? 'ok' : 'missing'}, ffprobe: ${haveFfprobe ? 'ok' : 'missing'}).`,
    );
    log.error('Install FFmpeg, or set FFMPEG_PATH / FFPROBE_PATH in .env, then re-run.');
    return 2;
  }
  log.ok(`ffmpeg + ffprobe available`);

  // A build without drawtext/subtitles fails deep inside the filter graph with
  // an opaque message. Catch it here and say what to install.
  const filters = await checkRequiredFilters();
  if (!filters.ok) {
    log.error(`FFmpeg is missing required filter(s): ${filters.missing.join(', ')}`);
    for (const line of missingFilterHelp(filters.missing).split('\n')) log.error(line);
    return 2;
  }
  log.ok('ffmpeg has drawtext + subtitles');

  const font = koreanFontFileOrNull();
  if (!font) {
    log.error('No Korean-capable font found — burn-in Korean text would render as empty boxes.');
    log.error('Install one (e.g. `fonts-noto-cjk`) or set KOREAN_FONT_FILE in .env.');
    return 2;
  }
  log.ok(`Korean font: ${font}`);
  if (!cfg.serviceKey) {
    log.warn('KCISA_SERVICE_KEY is not set — no sign can be confirmed against KCISA.');
    if (mode === 'render') {
      log.error('Refusing to render without the authoritative KSL reference. Add the key to .env.');
      return 2;
    }
    log.warn('preview mode continues, but the output will be marked NOT publishable.');
  } else {
    log.ok(`KCISA key loaded, endpoint ${cfg.baseUrl}/${cfg.operation}`);
  }

  // --- [2] topic -----------------------------------------------------------
  log.step('Selecting topic...');
  const topic = selectTopic({
    ...(args.topic ? { requestedTopic: args.topic } : {}),
    ...(args.series ? { requestedSeries: args.series } : {}),
    random: args.random,
    force: args.force,
  });

  // --- [3] + [4] KSL: KCISA lookup, then the verified clip -----------------
  log.step('Querying KCISA 한국수어 OpenAPI...');
  const matchOutcome = await matchKslWords(topic.kslWords);
  const apiFailure = matchOutcome.apiFailure;
  if (apiFailure) {
    log.blank();
    log.error(`KSL_DATA_UNAVAILABLE — ${apiFailure.reason}`);
    log.error(apiFailure.message);
    if (apiFailure.rawLogPath) log.error(`raw response saved: ${rel(apiFailure.rawLogPath)}`);
    if (mode === 'render') {
      log.blank();
      log.error('Stopping. No sign language data is invented to fill this gap.');
      return 3;
    }
    log.warn('preview mode continues with placeholders; the output is NOT publishable.');
  }

  log.step('Matching verified KSL clip...');
  const verifiedWords = await verifiedWordsAvailable();
  if (verifiedWords.length) log.info(`verified clips on hand: ${verifiedWords.join(', ')}`);
  else log.warn('assets/ksl/ contains no verified clips yet (see assets/ksl/README.md)');

  const allVerified = matchOutcome.allVerified;
  if (!allVerified && mode === 'render') {
    log.blank();
    log.error('NEEDS_KSL_RECORDING — at least one sign has no verified human clip.');
    for (const m of matchOutcome.matches) {
      if (m.status === 'VERIFIED') continue;
      log.error(`  "${m.word}":`);
      m.problems.forEach((p) => log.error(`    · ${p}`));
    }
    log.blank();
    if (verifiedWords.length) {
      log.info(`Signs you could feature instead, right now: ${verifiedWords.join(', ')}`);
    }
    log.info('Or run `npm run shorts:preview` to render a placeholder preview.');
    log.error('Stopping rather than generating sign language.');
    return 4;
  }

  // --- [5] script ----------------------------------------------------------
  log.step('Building script...');
  const script = generateContent({ topic, verifiedWords });

  // --- [6] timeline --------------------------------------------------------
  log.step('Building timeline...');
  const timeline = buildTimeline({
    script,
    matches: matchOutcome.matches,
    mode,
    brollTags: topic.brollTags ?? [],
  });

  // --- output folder -------------------------------------------------------
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(topic.topic, date);
  const outDir = path.join(P.output, slug);
  const workDir = path.join(outDir, '.render');
  fs.mkdirSync(workDir, { recursive: true });

  // --- [7] captions --------------------------------------------------------
  log.step('Creating captions...');
  const cues = timelineToCues(timeline);
  const koSrtFile = path.join(outDir, vid.subtitle.sidecar.ko);
  const enSrtFile = path.join(outDir, vid.subtitle.sidecar.en);
  writeText(koSrtFile, buildSrt(cues, 'ko'));
  writeText(enSrtFile, buildSrt(cues, 'en'));
  const assFile = path.join(workDir, 'burn-in.ass');
  writeText(assFile, buildAss(timeline));
  log.ok(`${rel(koSrtFile)} + ${rel(enSrtFile)}`);

  writeText(path.join(outDir, 'script.ko.txt'), scriptToText(script, 'ko'));
  writeText(path.join(outDir, 'script.en.txt'), scriptToText(script, 'en'));

  // --- [8] render ----------------------------------------------------------
  log.step('Rendering Shorts...');
  const render = await renderShort({
    timeline,
    outputFile: path.join(outDir, 'shorts.mp4'),
    workDir,
    assFile,
    mode,
  });

  // --- metadata + manifest -------------------------------------------------
  const kcisaFetchedAt =
    matchOutcome.matches.find((m) => m.kcisaRecord)?.kcisaRecord?.sourceEndpoint ? new Date().toISOString() : null;
  const metadata = buildMetadata({
    script,
    matches: matchOutcome.matches,
    kcisaEndpoint: cfg.operation,
    musicAttribution: timeline.musicAttribution,
    mode,
  });

  const files: Record<string, string> = {
    video: 'shorts.mp4',
    thumbnail: path.basename(render.thumbnailFile),
    metadata: 'metadata.json',
    'script.ko': 'script.ko.txt',
    'script.en': 'script.en.txt',
    'captions.ko': vid.subtitle.sidecar.ko,
    'captions.en': vid.subtitle.sidecar.en,
    report: 'verification-report.md',
  };
  if (timeline.musicFile) files['music'] = timeline.musicFile;

  const manifest: OutputManifest = {
    brand: { nameKo: b.brandNameKo, nameEn: b.brandNameEn, descriptor: b.descriptor },
    createdAt: new Date().toISOString(),
    slug,
    topic: topic.topic,
    topicId: topic.id,
    series: script.series,
    mode,
    durationSeconds: render.durationSeconds,
    script,
    ksl: {
      words: topic.kslWords,
      matches: matchOutcome.matches,
      source: matchOutcome.matches.some((m) => m.kcisaRecord) ? 'KCISA' : 'NONE',
      apiMatch: matchOutcome.anyKcisaFail ? 'FAIL' : 'PASS',
      verifiedHumanClip: allVerified ? 'YES' : 'NO',
      kcisaEndpoint: cfg.operation,
      kcisaFetchedAt,
    },
    commercial: script.commercial,
    youtube: metadata,
    files,
    verification: null,
    publishReady: false,
  };
  writeJson(path.join(outDir, 'metadata.json'), manifest);

  // --- [9] QA --------------------------------------------------------------
  log.step('Verifying output...');
  const verification = await verifyOutput({ dir: outDir, manifest });
  manifest.verification = verification;
  manifest.publishReady = verification.publishReady;
  writeJson(path.join(outDir, 'metadata.json'), manifest);
  writeText(path.join(outDir, 'verification-report.md'), renderVerificationReport(manifest, verification));
  logVerification(verification);

  markTopicUsed(topic.id, mode);
  appendHistory({
    createdAt: manifest.createdAt,
    slug: `${slug}-${script.structureVariant}`,
    topicId: topic.id,
    topic: topic.topic,
    series: script.series,
    brollUsed: timeline.brollUsed,
    mode,
    publishReady: verification.publishReady,
  });

  // --- summary -------------------------------------------------------------
  log.raw(`\n${'─'.repeat(60)}`);
  log.raw(`📁 ${rel(outDir)}`);
  log.raw(`   shorts.mp4              ${render.durationSeconds.toFixed(1)}s · ${vid.canvas.width}×${vid.canvas.height} · ${vid.canvas.fps}fps`);
  log.raw(`   thumbnail.jpg`);
  log.raw(`   captions.ko.srt / captions.en.srt`);
  log.raw(`   script.ko.txt / script.en.txt`);
  log.raw(`   metadata.json`);
  log.raw(`   verification-report.md`);
  log.raw('');
  log.raw(`KSL Source: ${verification.kslSource}`);
  log.raw(`KSL API Match: ${verification.kslApiMatch}`);
  log.raw(`Verified Human Clip: ${verification.verifiedHumanClip}`);
  log.raw(`PUBLISH_READY=${verification.publishReady}`);
  log.raw('');
  if (verification.publishReady) {
    log.raw(`▶ Review it, then: npm run youtube:upload -- ${rel(outDir)}`);
    log.raw('  (uploads as private — you flip it public yourself)');
  } else {
    log.raw('▶ Not publishable yet. See verification-report.md for exactly what is missing.');
  }
  log.raw(`${'─'.repeat(60)}\n`);

  return verification.publishReady ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    log.blank();
    log.error((err as Error).message);
    if (process.env['LOG_LEVEL'] === 'debug') console.error(err);
    process.exit(1);
  });
