import fs from 'node:fs';
import path from 'node:path';
import { P, rel } from '../src/util/paths.js';
import { brand, koreanFontFileOrNull } from '../src/util/config.js';
import { env, maskSecret } from '../src/util/env.js';
import { ffmpegBin, ffprobeBin, run, toolAvailable } from '../src/util/exec.js';
import { log } from '../src/util/log.js';
import { kcisaConfig } from '../src/api/kcisa.js';
import { loadKslLibrary, verifyClipMetadata } from '../src/ksl/verifier.js';
import { discoverBroll, discoverMusic } from '../src/video/assets.js';
import { loadTopics } from '../src/content/selectTopic.js';

// Environment check. Reports what is ready and what is missing, and never
// pretends a missing dependency is fine.

async function version(bin: string): Promise<string> {
  try {
    const r = await run(bin, ['-version'], 15_000);
    return r.stdout.split('\n')[0] ?? 'unknown';
  } catch {
    return 'not found';
  }
}

async function main(): Promise<number> {
  const b = brand();
  log.raw(`\n${b.brandNameKo} · ${b.brandNameEn} — environment check\n`);

  let blocking = 0;
  const line = (ok: boolean | 'warn', label: string, detail: string) => {
    const icon = ok === true ? '✅' : ok === 'warn' ? '⚠️ ' : '❌';
    log.raw(`${icon} ${label.padEnd(26)} ${detail}`);
    if (ok === false) blocking += 1;
  };

  line(true, 'node', process.version);
  const haveFfmpeg = await toolAvailable(ffmpegBin());
  line(haveFfmpeg, 'ffmpeg', haveFfmpeg ? await version(ffmpegBin()) : 'not found — required for rendering');
  const haveFfprobe = await toolAvailable(ffprobeBin());
  line(haveFfprobe, 'ffprobe', haveFfprobe ? await version(ffprobeBin()) : 'not found — required for QA');

  const font = koreanFontFileOrNull();
  line(
    Boolean(font),
    'Korean font',
    font ?? 'none found — install fonts-noto-cjk or set KOREAN_FONT_FILE',
  );

  const cfg = kcisaConfig();
  line(
    Boolean(cfg.serviceKey),
    'KCISA_SERVICE_KEY',
    cfg.serviceKey ? maskSecret(cfg.serviceKey) : 'not set — no sign can be verified (see .env.example)',
  );
  log.raw(`   endpoint: ${cfg.baseUrl}/${cfg.operation}`);
  log.raw(`   query param: ${cfg.queryParam} · key param: ${cfg.keyParam}`);

  const clips = await loadKslLibrary(false);
  const verified = clips.filter((c) => verifyClipMetadata(c.metadata, c.file).usable);
  line(
    verified.length > 0,
    'verified KSL clips',
    verified.length
      ? `${verified.length} of ${clips.length} clip file(s): ${verified.map((c) => c.word).join(', ')}`
      : `${clips.length} clip file(s), 0 verified — rendering is blocked until one exists (assets/ksl/README.md)`,
  );
  for (const clip of clips) {
    const check = verifyClipMetadata(clip.metadata, clip.file);
    if (!check.usable) log.raw(`   · ${rel(clip.file)}: ${check.problems.join('; ')}`);
  }

  const broll = discoverBroll();
  line(
    broll.length > 0 ? true : 'warn',
    'B-roll',
    broll.length ? `${broll.length} file(s)` : 'none — non-signing beats render as typographic cards',
  );

  const music = discoverMusic();
  line(
    music.length > 0 ? true : 'warn',
    'cleared music',
    music.length ? `${music.length} track(s)` : 'none — videos render silent (which is fine here)',
  );

  try {
    const { topics } = loadTopics();
    line(true, 'topics', `${topics.length} seed(s) in ${rel(P.topics)}`);
  } catch (err) {
    line(false, 'topics', (err as Error).message);
  }

  const youtubeReady = Boolean(
    env('YOUTUBE_CLIENT_ID') && env('YOUTUBE_CLIENT_SECRET') && env('YOUTUBE_REFRESH_TOKEN'),
  );
  line(
    youtubeReady ? true : 'warn',
    'YouTube OAuth',
    youtubeReady ? 'client id + secret + refresh token present' : 'not configured — upload step is unavailable',
  );

  const envFile = path.join(P.root, '.env');
  line(
    fs.existsSync(envFile) ? true : 'warn',
    '.env',
    fs.existsSync(envFile) ? 'present (git-ignored)' : 'missing — `cp .env.example .env` and fill it in',
  );

  log.raw('');
  if (blocking === 0) log.raw('Ready. Nothing blocking.\n');
  else log.raw(`${blocking} blocking item(s) above.\n`);
  return blocking === 0 ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((err: unknown) => {
    log.error((err as Error).message);
    process.exit(1);
  });
