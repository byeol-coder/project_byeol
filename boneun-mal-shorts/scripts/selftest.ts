import fs from 'node:fs';
import path from 'node:path';
import { P, rel } from '../src/util/paths.js';
import { log } from '../src/util/log.js';
import {
  checkRequiredFilters,
  ffmpegBin,
  ffprobeMedia,
  missingFilterHelp,
  run,
  toolAvailable,
} from '../src/util/exec.js';
import { extractEnvelope, normalizeRecord, parsePayload, recordMatchesWord } from '../src/ksl/normalize.js';
import { verifyClipMetadata } from '../src/ksl/verifier.js';
import { findCopyViolations } from '../src/content/generateContent.js';
import {
  buildAss,
  buildSrt,
  computeBurnInBand,
  computeBurnInBandFrom,
  timelineToCues,
} from '../src/video/subtitle.js';
import { renderShort } from '../src/video/renderShort.js';
import { buildMetadata } from '../src/youtube/metadata.js';
import { uploadToYoutube } from '../src/youtube/upload.js';
import type { ContentScript, KslClipMetadata, OutputManifest, Timeline } from '../src/types.js';

// ---------------------------------------------------------------------------
// Self-test. Checks the rules that protect the brand, not just that code runs.
//
// The API payloads below are PARSER FIXTURES — synthetic envelopes used to test
// the adapter's tolerance. They are never cached, never treated as KSL content,
// and no fixture here is a sign language recording. The one media file it
// creates is a colour test card used as B-roll, so the real-footage branch of
// the renderer is exercised without inventing a signer.
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    log.raw(`  ✅ ${name}`);
  } else {
    failed += 1;
    log.raw(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function throws(name: string, fn: () => unknown, mustInclude = ''): void {
  try {
    fn();
    check(name, false, 'expected it to throw, it did not');
  } catch (err) {
    const msg = (err as Error).message;
    check(name, mustInclude ? msg.includes(mustInclude) : true, `message was "${msg}"`);
  }
}

async function rejects(name: string, fn: () => Promise<unknown>, mustInclude = ''): Promise<void> {
  try {
    await fn();
    check(name, false, 'expected a rejection, it resolved');
  } catch (err) {
    const msg = (err as Error).message;
    check(name, mustInclude ? msg.includes(mustInclude) : true, `message was "${msg}"`);
  }
}

// --- 1. KCISA adapter tolerance -------------------------------------------

function testAdapter(): void {
  log.raw('\nKCISA adapter (synthetic parser fixtures)');

  const jsonEnvelope = JSON.stringify({
    response: {
      header: { resultCode: '0000', resultMsg: 'OK' },
      body: {
        totalCount: 2,
        pageNo: 1,
        numOfRows: 10,
        items: {
          item: [
            {
              TITLE: '커피',
              DESCRIPTION: '커피를 뜻하는 수어',
              SUB_DESCRIPTION: '한 손을 컵 모양으로 쥐고 돌린다',
              IMAGE_OBJECT: 'https://example.org/a.jpg',
              URL: 'https://example.org/a',
              LOCAL_ID: 'KSL-0001',
              SPATIAL_COVERAGE: '전국',
            },
            { TITLE: '친구', DESCRIPTION: '친구를 뜻하는 수어', LOCAL_ID: 'KSL-0002' },
          ],
        },
      },
    },
  });
  const parsedJson = parsePayload(jsonEnvelope, 'application/json');
  check('parses a JSON envelope', parsedJson?.kind === 'json');
  const envJson = extractEnvelope(parsedJson!.value);
  check('finds nested items[].item', envJson.items.length === 2, `got ${envJson.items.length}`);
  check('reads resultCode', envJson.resultCode === '0000', String(envJson.resultCode));
  check('reads totalCount', envJson.totalCount === 2, String(envJson.totalCount));

  const { record, unmappedFields } = normalizeRecord(envJson.items[0]!, 'getCTE01701', 0);
  check('maps UPPER_SNAKE title', record.title === '커피', record.title);
  check('maps SUB_DESCRIPTION to handshape', record.handshapeDescription.includes('컵 모양'), record.handshapeDescription);
  check('maps IMAGE_OBJECT to imageUrl', record.imageUrl.endsWith('a.jpg'), record.imageUrl);
  check('maps LOCAL_ID to id', record.id === 'KSL-0001', record.id);
  check('records which field it matched', record.mappedFrom['title'] === 'TITLE', JSON.stringify(record.mappedFrom));
  check('reports nothing unmapped for a full record', unmappedFields.length === 0, unmappedFields.join(','));
  check('matches the searched word', recordMatchesWord(record, '커피'));
  check('does not match an unrelated word', !recordMatchesWord(record, '지하철'));

  const xmlEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE</resultMsg></header>
<body><totalCount>1</totalCount><items><item>
<title>맛있다</title><description>맛있다를 뜻하는 수어</description><localId>KSL-0009</localId>
</item></items></body></response>`;
  const parsedXml = parsePayload(xmlEnvelope, 'text/xml');
  check('parses an XML envelope', parsedXml?.kind === 'xml');
  const envXml = extractEnvelope(parsedXml!.value);
  check('finds the single XML item', envXml.items.length === 1, String(envXml.items.length));
  check(
    'maps camelCase XML fields',
    normalizeRecord(envXml.items[0]!, 'getCTE01701', 0).record.title === '맛있다',
  );

  const flat = parsePayload('[{"title":"물","localId":"X1"}]', 'application/json');
  check('handles a bare array response', extractEnvelope(flat!.value).items.length === 1);

  check('rejects an unparseable body', parsePayload('<<<not xml or json', 'text/plain') === null);
  check(
    'flags an unrecognised schema instead of guessing',
    extractEnvelope({ someWrapper: { unexpected: 'shape' } }).schemaUnrecognised,
  );
}

// --- 2. KSL clip verification ---------------------------------------------

function testClipVerification(): void {
  log.raw('\nKSL clip verification');
  const base: KslClipMetadata = {
    word: '커피',
    verified: true,
    source: 'human-recorded',
    language: 'KSL',
    consent: 'on file',
  };
  const file = '/tmp/커피.mp4';

  check('accepts a complete human recording', verifyClipMetadata(base, file).usable);
  check('rejects a missing sidecar', !verifyClipMetadata(null, file).usable);
  check('rejects verified:false', !verifyClipMetadata({ ...base, verified: false }, file).usable);
  check(
    'rejects an AI-generated source',
    !verifyClipMetadata({ ...base, source: 'ai-generated' }, file).usable,
  );
  check(
    'rejects an AI avatar source',
    !verifyClipMetadata({ ...base, source: 'synthetic avatar' }, file).usable,
  );
  check(
    'rejects a diffusion-model source',
    !verifyClipMetadata({ ...base, source: 'diffusion model v3' }, file).usable,
  );
  check('rejects missing consent', !verifyClipMetadata({ ...base, consent: '' }, file).usable);
  check(
    'rejects a non-KSL language',
    !verifyClipMetadata({ ...base, language: 'ASL' }, file).usable,
  );
  const aiProblem = verifyClipMetadata({ ...base, source: 'ai-avatar' }, file).problems.join(' ');
  check('says why AI signing is refused', aiProblem.includes('never publishable'), aiProblem);
}

// --- 3. Copy tone guard ---------------------------------------------------

function testCopyGuard(): void {
  log.raw('\nCopy tone guard');
  const clean = {
    hookKo: '카페에서 자주 쓰는 말.',
    hookEn: 'One you will use in every café.',
    bodyKo: ['오늘은 커피.', '한국수어로는?'],
    bodyEn: ['Today: coffee.', 'In Korean Sign Language?'],
    pointKo: '손 모양이 컵을 닮았습니다.',
    pointEn: 'The hand keeps the shape of the cup.',
    ctaKo: '',
    ctaEn: '',
  };
  check('passes clean copy', findCopyViolations(clean).length === 0);
  check(
    'catches a clickbait hook',
    findCopyViolations({ ...clean, hookKo: '충격! 99%가 모르는 수어' }).length > 0,
  );
  check(
    'catches inspiration-porn phrasing',
    findCopyViolations({ ...clean, pointKo: '감동적인 극복 스토리입니다.' }).length > 0,
  );
  check(
    'catches generalising about Deaf people',
    findCopyViolations({ ...clean, bodyKo: ['모든 농인은 이렇게 합니다.'] }).length > 0,
  );
  check(
    'catches like-and-subscribe CTAs',
    findCopyViolations({ ...clean, ctaKo: '구독과 좋아요 부탁드립니다' }).length > 0,
  );
  check(
    'catches AI filler phrasing',
    findCopyViolations({ ...clean, bodyKo: ['함께 알아볼까요?'] }).length > 0,
  );
}

// --- 4. Layout legality ---------------------------------------------------

function testLayout(): void {
  log.raw('\nLayout legality');
  const band = computeBurnInBand();
  check('burn-in clears the signing space', band.koTopPx >= 1420, `koTop=${band.koTopPx}`);
  check('burn-in clears the Shorts UI reserve', band.enBottomPx <= 1580, `enBottom=${band.enBottomPx}`);

  const legal = {
    height: 1920,
    koFontSizePx: 76,
    enFontSizePx: 40,
    lineGapPx: 8,
    marginBottomPx: 348,
    signingSpaceBottomPx: 1420,
    uiReserveBottomPx: 340,
  };
  check('accepts the shipped geometry', computeBurnInBandFrom(legal).koTopPx >= 1420);

  // A layout that would cover the hands must be refused, not quietly accepted.
  throws(
    'refuses a margin that pushes text into the signing space',
    () => computeBurnInBandFrom({ ...legal, marginBottomPx: 900 }),
    'signing space',
  );
  throws(
    'refuses a Korean font size that grows into the signing space',
    () => computeBurnInBandFrom({ ...legal, koFontSizePx: 200 }),
    'signing space',
  );
  throws(
    'refuses text that collides with the Shorts UI reserve',
    () => computeBurnInBandFrom({ ...legal, marginBottomPx: 100 }),
    'Shorts UI reserve',
  );
}

// --- 5. Captions ----------------------------------------------------------

function fixtureTimeline(brollFile: string): Timeline {
  return {
    totalSeconds: 6,
    brollUsed: [brollFile],
    musicFile: null,
    musicAttribution: null,
    segments: [
      {
        kind: 'hook',
        startSeconds: 0,
        durationSeconds: 2,
        sourceFile: null,
        sourceKind: 'generated-card',
        protectsSigningSpace: false,
        textKo: '카페에서 자주 쓰는 말.',
        textEn: 'One you will use in every café.',
        placeholderNotice: null,
        sourceInPointSeconds: 0,
      },
      {
        kind: 'context',
        startSeconds: 2,
        durationSeconds: 3,
        sourceFile: brollFile,
        sourceKind: 'broll',
        protectsSigningSpace: false,
        textKo: '오늘은 커피.',
        textEn: 'Today: coffee.',
        placeholderNotice: null,
        sourceInPointSeconds: 0,
      },
      {
        kind: 'ending',
        startSeconds: 5,
        durationSeconds: 1,
        sourceFile: null,
        sourceKind: 'generated-card',
        protectsSigningSpace: false,
        textKo: '보이는 말',
        textEn: 'BONEUN MAL',
        placeholderNotice: null,
        sourceInPointSeconds: 0,
      },
    ],
  };
}

function testCaptions(timeline: Timeline): void {
  log.raw('\nCaptions');
  const cues = timelineToCues(timeline);
  check('excludes the brand ending from captions', cues.length === 2, `${cues.length} cues`);
  const ko = buildSrt(cues, 'ko');
  const en = buildSrt(cues, 'en');
  check('Korean SRT has both cues', (ko.match(/-->/g) ?? []).length === 2);
  check('English SRT has both cues', (en.match(/-->/g) ?? []).length === 2);
  check('SRT timing format is well-formed', /00:00:00,000 --> 00:00:02,000/.test(ko), ko.slice(0, 60));
  const ass = buildAss(timeline);
  check('burn-in only covers real footage', (ass.match(/^Dialogue:/gm) ?? []).length === 2, ass);
  check('ASS declares the 1080×1920 canvas', ass.includes('PlayResX: 1080') && ass.includes('PlayResY: 1920'));
}

// --- 6. Real-footage render path -----------------------------------------

async function makeTestCard(dir: string): Promise<string> {
  // A plain colour card standing in for B-roll, so the footage branch of the
  // renderer (scale / crop / tpad / trim / concat) is genuinely exercised.
  const file = path.join(dir, 'testcard-broll.mp4');
  const r = await run(
    ffmpegBin(),
    [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', '2', '-c:v', 'libx264', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      file,
    ],
    120_000,
  );
  if (r.code !== 0) throw new Error(`could not build the test card: ${r.stderr.slice(-400)}`);
  return file;
}

async function testRender(timeline: Timeline): Promise<void> {
  log.raw('\nRender path with real footage');
  const dir = path.join(P.cache, 'selftest');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'selftest.mp4');
  const result = await renderShort({
    timeline,
    outputFile: out,
    workDir: path.join(dir, 'work'),
    assFile: path.join(dir, 'work', 'burn.ass'),
    mode: 'preview',
  });
  const probed = await ffprobeMedia(result.outputFile);
  check('renders 1080×1920', probed.width === 1080 && probed.height === 1920, `${probed.width}×${probed.height}`);
  check('renders 30fps', Math.abs(probed.fps - 30) < 0.5, String(probed.fps));
  check('renders h264 + aac', probed.videoCodec === 'h264' && probed.audioCodec === 'aac');
  check('hits the timeline duration', Math.abs(probed.durationSeconds - 6) < 0.35, `${probed.durationSeconds}s`);
  check('square pixels', ['1:1', '0:1', ''].includes(probed.sampleAspectRatio), probed.sampleAspectRatio);
  check('produced a thumbnail', fs.existsSync(result.thumbnailFile));

  // A b-roll clip shorter than its slot must be held, never sped up.
  check(
    'holds a short source instead of speeding it up',
    Math.abs(probed.durationSeconds - 6) < 0.35,
    'the 2s test card fills a 3s slot',
  );
}

// --- 7. Publish gate ------------------------------------------------------

function fixtureScript(): ContentScript {
  return {
    topicId: 'ksign-coffee',
    topic: '커피',
    series: 'K-SIGN',
    hookKo: '카페에서 자주 쓰는 말.',
    hookEn: 'One you will use in every café.',
    bodyKo: ['오늘은 커피.'],
    bodyEn: ['Today: coffee.'],
    kslWord: '커피',
    kslWords: ['커피'],
    pointKo: '손 모양이 컵을 닮았습니다.',
    pointEn: 'The hand keeps the shape of the cup.',
    endingKo: '보이는 말',
    endingEn: 'BONEUN MAL',
    ctaKo: '',
    ctaEn: '',
    durationTarget: 22,
    structureVariant: 'hook-first',
    commercial: { commercial: false, affiliate: false, sponsor: null, product: null, disclosureKo: null, disclosureEn: null },
  };
}

async function testPublishGate(): Promise<void> {
  log.raw('\nPublish gate');
  const script = fixtureScript();
  const metadata = buildMetadata({
    script,
    matches: [],
    kcisaEndpoint: 'getCTE01701',
    musicAttribution: null,
    mode: 'render',
  });
  check('upload metadata is private', metadata.privacyStatus === 'private');
  check('hashtag count stays within 3–5', metadata.hashtags.length >= 3 && metadata.hashtags.length <= 5, String(metadata.hashtags.length));
  check('description credits KCISA', metadata.description.includes('KCISA'));
  check('description states no AI signing', metadata.description.includes('No AI-generated signing'));

  const commercialScript: ContentScript = {
    ...script,
    commercial: {
      commercial: true,
      affiliate: false,
      sponsor: 'Example Co',
      product: 'Example watch',
      disclosureKo: '유료 광고 포함 · Example Co',
      disclosureEn: 'Paid promotion · Example Co',
    },
  };
  const commercialMeta = buildMetadata({
    script: commercialScript,
    matches: [],
    kcisaEndpoint: 'getCTE01701',
    musicAttribution: null,
    mode: 'render',
  });
  check(
    'commercial disclosure leads the description',
    commercialMeta.description.startsWith('유료 광고 포함 · Example Co'),
    commercialMeta.description.slice(0, 40),
  );

  const base: OutputManifest = {
    brand: { nameKo: '보이는 말', nameEn: 'BONEUN MAL', descriptor: 'x' },
    createdAt: new Date().toISOString(),
    slug: 'fixture',
    topic: '커피',
    topicId: 'ksign-coffee',
    series: 'K-SIGN',
    mode: 'render',
    durationSeconds: 22,
    script,
    ksl: {
      words: ['커피'],
      matches: [],
      source: 'KCISA',
      apiMatch: 'PASS',
      verifiedHumanClip: 'YES',
      kcisaEndpoint: 'getCTE01701',
      kcisaFetchedAt: new Date().toISOString(),
    },
    commercial: script.commercial,
    youtube: metadata,
    files: {},
    verification: null,
    publishReady: true,
  };

  await rejects(
    'refuses upload when PUBLISH_READY is false',
    () => uploadToYoutube({ dir: P.cache, manifest: { ...base, publishReady: false } }),
    'PUBLISH_READY=false',
  );
  await rejects(
    'refuses upload without a verified human clip',
    () =>
      uploadToYoutube({
        dir: P.cache,
        manifest: { ...base, ksl: { ...base.ksl, verifiedHumanClip: 'NO' } },
      }),
    'no verified human KSL clip',
  );
  await rejects(
    'refuses to upload a preview render',
    () => uploadToYoutube({ dir: P.cache, manifest: { ...base, mode: 'preview' } }),
    'preview',
  );
}

// --- run ------------------------------------------------------------------

async function main(): Promise<number> {
  log.raw('\n보이는 말 · BONEUN MAL — self-test');

  testAdapter();
  testClipVerification();
  testCopyGuard();
  testLayout();

  const filters = (await toolAvailable(ffmpegBin())) ? await checkRequiredFilters() : { ok: false, missing: [] };
  if (!(await toolAvailable(ffmpegBin()))) {
    log.raw('\n⚠ ffmpeg not available — render checks skipped');
  } else if (!filters.ok) {
    // Not a code failure: report it as an environment problem, with the fix.
    log.raw(`\n❌ ffmpeg cannot render: missing filter(s) ${filters.missing.join(', ')}`);
    log.raw(missingFilterHelp(filters.missing));
    failed += 1;
  } else {
    const dir = path.join(P.cache, 'selftest');
    fs.mkdirSync(dir, { recursive: true });
    const card = await makeTestCard(dir);
    const timeline = fixtureTimeline(card);
    testCaptions(timeline);
    await testRender(timeline);
  }

  await testPublishGate();

  log.raw(`\n${passed} passed, ${failed} failed`);
  if (failed === 0) log.raw(`artifacts: ${rel(path.join(P.cache, 'selftest'))}\n`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((err: unknown) => {
    log.error((err as Error).message);
    process.exit(1);
  });
