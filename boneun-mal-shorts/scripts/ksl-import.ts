import fs from 'node:fs';
import path from 'node:path';
import { P, rel } from '../src/util/paths.js';
import { log } from '../src/util/log.js';
import { writeJson } from '../src/util/json.js';
import { downloadFile } from '../src/util/download.js';
import { lookupWord } from '../src/api/kcisa.js';
import type { KslClipMetadata } from '../src/types.js';

// ---------------------------------------------------------------------------
// npm run ksl:import -- "커피" [--license "공공누리 제1유형"] [--license-url "https://…"]
//
// Downloads the official sign-language video the KCISA getCTE01701 response
// already links to — a recording published by 국립국어원 한국수어사전
// (sldict.korean.go.kr), a real signer, government-produced — instead of
// asking anyone to film it fresh.
//
// This is legitimate ONLY when the licence permits it. This script does not
// check that for you: confirm the 공공누리 licence type on data.go.kr or
// sldict.korean.go.kr yourself before running it, and pass it via --license so
// it ends up in the sidecar and in the published video's description. It also
// never substitutes when no usable video URL exists — that stays
// NEEDS_KSL_RECORDING, same as always.
// ---------------------------------------------------------------------------

interface Args {
  word: string;
  license: string;
  licenseUrl: string;
}

function parseArgs(argv: string[]): Args {
  const rest: string[] = [];
  let license = '공공누리 라이선스 (사용 전 data.go.kr에서 정확한 유형을 확인하세요)';
  let licenseUrl = '';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--license') license = argv[++i] ?? license;
    else if (a === '--license-url') licenseUrl = argv[++i] ?? '';
    else if (!a.startsWith('-')) rest.push(a);
  }
  return { word: rest.join(' '), license, licenseUrl };
}

async function main(): Promise<number> {
  const { word, license, licenseUrl } = parseArgs(process.argv.slice(2));
  if (!word) {
    log.error('Usage: npm run ksl:import -- "커피" [--license "공공누리 제1유형"] [--license-url "https://…"]');
    return 2;
  }

  log.raw(`\n국립국어원 한국수어사전 공식 영상 가져오기 — "${word}"\n`);

  const { result, exact } = await lookupWord(word);
  if (result.status === 'KSL_DATA_UNAVAILABLE') {
    log.error(`KSL_DATA_UNAVAILABLE — ${result.reason}: ${result.message}`);
    return 3;
  }
  if (!exact) {
    log.error(`KCISA에 "${word}" 항목이 없습니다. 가져올 것이 없습니다.`);
    return 4;
  }
  if (!exact.videoUrl || !/\.mp4(\?|$)/i.test(exact.videoUrl)) {
    log.error(
      `${exact.id} 레코드에 사용 가능한 영상 URL이 없습니다 (got "${exact.videoUrl || '(empty)'}"). ` +
        '이 단어는 직접 촬영이 필요합니다.',
    );
    return 5;
  }

  log.ok(`찾음: ${exact.id} — ${exact.title}`);
  if (exact.handshapeDescription) log.info(`손동작: ${exact.handshapeDescription}`);
  log.info(`영상: ${exact.videoUrl}`);

  const dest = path.join(P.kslAssets, `${word}.mp4`);
  if (fs.existsSync(dest)) {
    log.warn(`${rel(dest)} already exists — overwriting.`);
  }
  log.info(`다운로드 중 → ${rel(dest)}`);
  const dl = await downloadFile(exact.videoUrl, dest, { timeoutMs: 60_000, maxRetries: 3 });
  if (!dl.ok) {
    log.error(`다운로드 실패: ${dl.error}`);
    return 6;
  }
  log.ok(`저장됨: ${(dl.bytes / 1024).toFixed(0)} KB (${dl.contentType || 'unknown type'})`);

  const metadata: KslClipMetadata = {
    word,
    verified: true,
    source: 'kcisa-official-dictionary',
    language: 'KSL',
    consent: `공공누리 라이선스에 따른 정부 공식 콘텐츠 사용 — ${license}`,
    framing:
      '국립국어원 한국수어사전 표준 촬영본. 게시 전 얼굴·상체·양손이 잘리지 않고 온전히 ' +
      '보이는지 반드시 육안으로 한 번 확인하세요.',
    kcisaId: exact.id,
    notes: `KCISA ${exact.sourceEndpoint} 검색 결과 자동 임포트 (${new Date().toISOString().slice(0, 10)}).`,
    license,
    licenseUrl,
    attributionText: '자료 제공: 국립국어원 한국수어사전 (sldict.korean.go.kr)',
    officialSourceUrl: exact.videoUrl,
  };
  const sidecar = path.join(P.kslAssets, `${word}.json`);
  writeJson(sidecar, metadata);
  log.ok(`작성됨: ${rel(sidecar)}`);

  log.raw('\n⚠ 자동 임포트는 verified: true로 표시되지만, 이건 "정부가 촬영했다"는 사실만');
  log.raw('  확인한 것입니다. 실제 발행 전에 반드시 영상을 한 번 재생해서 얼굴·상체·양손이');
  log.raw(`  잘리지 않고 나오는지 직접 확인하세요. 문제가 있으면 ${rel(sidecar)}의`);
  log.raw('  "verified"를 false로 바꾸세요 — 그러면 이 단어는 다시 NEEDS_KSL_RECORDING이 됩니다.');
  log.raw('\n▶ npm run ksl:library   로 반영 확인\n');

  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err: unknown) => {
    log.error((err as Error).message);
    process.exit(1);
  });
