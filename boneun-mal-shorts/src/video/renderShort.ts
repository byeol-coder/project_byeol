import fs from 'node:fs';
import path from 'node:path';
import { brand, color, koreanFontFile, video as videoConfig } from '../util/config.js';
import { ffmpegBin, run } from '../util/exec.js';
import { log } from '../util/log.js';
import { rel } from '../util/paths.js';
import { assertOverlayLegal, buildAss, computeBurnInBand } from './subtitle.js';
import type { Timeline, TimelineSegment } from '../types.js';

// ---------------------------------------------------------------------------
// FFmpeg renderer: 1080×1920, 30fps, H.264 / AAC, one pass.
//
// Two rules shape every decision here:
//   · Signing clips are never cropped — they letterbox onto the canvas, because
//     a crop can cut a hand out of the sentence.
//   · Nothing is drawn inside the signing space, and burn-in text stays in the
//     band below it and above the Shorts UI reserve.
// ---------------------------------------------------------------------------

/** Escape a value used inside an ffmpeg filter option. */
function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,');
}

function hexToFfmpeg(hex: string): string {
  return `0x${hex.replace('#', '')}`;
}

export interface RenderOptions {
  timeline: Timeline;
  outputFile: string;
  workDir: string;
  assFile: string;
  mode: 'render' | 'preview';
}

export interface RenderResult {
  outputFile: string;
  thumbnailFile: string;
  ffmpegCommand: string;
  durationSeconds: number;
}

interface CardText {
  file: string;
  fontSize: number;
  color: string;
  yPx: number;
}

function writeTextFile(workDir: string, name: string, text: string): string {
  const file = path.join(workDir, `${name}.txt`);
  // drawtext reads the file verbatim; no trailing newline, or it renders a gap.
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

/** CJK glyphs render close to square; Latin/punctuation run narrower. */
function estimateCharWidthPx(ch: string, fontSizePx: number): number {
  const code = ch.codePointAt(0) ?? 0;
  const isWide =
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x3130 && code <= 0x318f) || // Hangul Compat Jamo
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
    (code >= 0x3000 && code <= 0x303f) || // CJK punctuation
    (code >= 0x4e00 && code <= 0x9fff); // CJK Unified Ideographs
  if (/\s/.test(ch)) return fontSizePx * 0.32;
  return fontSizePx * (isWide ? 0.98 : 0.58);
}

function textWidthPx(text: string, fontSizePx: number): number {
  let w = 0;
  for (const ch of text) w += estimateCharWidthPx(ch, fontSizePx);
  return w;
}

/**
 * Card text is drawn as one centered block with no automatic wrapping —
 * drawtext just draws whatever it's given on a single line, however wide.
 * Without this, a line a couple of words longer than usual runs straight off
 * both edges of the canvas (see the "안내방송이 안 들려도" hook: 17 characters
 * at the card's 96px Korean size is ~1600px wide against a 1080px canvas).
 * Wraps at word boundaries to fit maxWidthPx; drawtext renders the embedded
 * newlines natively via its existing line_spacing option.
 */
function wrapToWidth(text: string, fontSizePx: number, maxWidthPx: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return text;
  const lines: string[] = [];
  let current = '';

  const hardSplit = (word: string): void => {
    let chunk = '';
    for (const ch of word) {
      const next = chunk + ch;
      if (chunk && textWidthPx(next, fontSizePx) > maxWidthPx) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk = next;
      }
    }
    current = chunk;
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidthPx(candidate, fontSizePx) <= maxWidthPx) {
      current = candidate;
    } else if (!current) {
      // A single word alone is already too wide (long compound noun, URL-ish
      // string) — split it by character rather than let it overflow anyway.
      if (textWidthPx(word, fontSizePx) > maxWidthPx) hardSplit(word);
      else current = word;
    } else {
      lines.push(current);
      current = textWidthPx(word, fontSizePx) > maxWidthPx ? '' : word;
      if (!current) hardSplit(word);
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

/**
 * Typographic card for beats with no footage. Korean big, English small beneath.
 * Deliberately plain: solid ground, one accent, no gradient — no neon motion
 * graphics. A short fade-in on the text is the one concession to motion, so a
 * run of cards doesn't read as a slideshow of frozen frames.
 */
function cardFilters(
  segment: TimelineSegment,
  index: number,
  workDir: string,
  fontFile: string,
): { background: string; drawtexts: string[] } {
  const b = brand();
  const vid = videoConfig();
  const h = vid.canvas.height;
  const isEnding = segment.kind === 'ending';
  const isPlaceholder = segment.sourceKind === 'placeholder';

  const ground = isPlaceholder || isEnding ? color('inkBlack') : color('warmIvory');
  const ink = isPlaceholder || isEnding ? color('warmIvory') : color('inkBlack');
  // One accent colour per card, per the brand rules.
  const secondary = color('mutedKoreanRed');

  const hierarchy = b.typography.hierarchy as Record<string, number>;
  const koSize = isEnding ? (hierarchy['brandKoSizePx'] ?? 104) : (hierarchy['koreanSizePx'] ?? 96);
  const enSize = isEnding ? (hierarchy['brandEnSizePx'] ?? 40) : (hierarchy['englishSizePx'] ?? 46);

  // Text block sits in the upper-middle third, comfortably inside the safe area.
  const blockCenter = isEnding ? Math.round(h * 0.5) : Math.round(h * 0.42);
  const texts: CardText[] = [];

  // Horizontal breathing room each side, independent of the burn-in subtitle
  // safe area (that one's asymmetric for the Shorts UI; cards are centered
  // text with nothing to dodge).
  const cardMarginPx = 96;
  const maxTextWidthPx = vid.canvas.width - cardMarginPx * 2;
  const LINE_BOX = 1.25;
  const LINE_GAP_PX = 14;
  const BLOCK_GAP_PX = 22;

  const blockHeightPx = (wrapped: string, fontSizePx: number): number => {
    const lines = wrapped.split('\n').length;
    return lines * Math.round(fontSizePx * LINE_BOX) + (lines - 1) * LINE_GAP_PX;
  };

  /** Wraps to fit the canvas, writes the file, and advances the layout cursor past it. */
  const addLine = (
    cursor: { y: number },
    name: string,
    rawText: string,
    fontSize: number,
    lineColor: string,
    gapAfterPx = BLOCK_GAP_PX,
  ): void => {
    const wrapped = wrapToWidth(rawText, fontSize, maxTextWidthPx);
    texts.push({ file: writeTextFile(workDir, name, wrapped), fontSize, color: lineColor, yPx: cursor.y });
    cursor.y += blockHeightPx(wrapped, fontSize) + gapAfterPx;
  };

  if (isPlaceholder) {
    const cursor = { y: blockCenter - 120 };
    addLine(cursor, `seg${index}-notice`, segment.placeholderNotice ?? '', 54, secondary);
    addLine(cursor, `seg${index}-ko`, segment.textKo, koSize, ink);
    addLine(cursor, `seg${index}-en`, 'Record this sign with a real signer before publishing.', 38, color('stone'));
  } else {
    const cursor = { y: blockCenter };
    if (segment.textKo.trim()) addLine(cursor, `seg${index}-ko`, segment.textKo.trim(), koSize, ink);
    if (segment.textEn.trim()) {
      addLine(
        cursor,
        `seg${index}-en`,
        segment.textEn.trim().toUpperCase(),
        enSize,
        isEnding ? secondary : color('stone'),
        isEnding ? BLOCK_GAP_PX + 40 : BLOCK_GAP_PX,
      );
    }
    if (isEnding && b.ending.showDescriptor) {
      addLine(cursor, `seg${index}-desc`, b.descriptor, hierarchy['descriptorSizePx'] ?? 30, color('stone'));
    }
  }

  const drawtexts = texts.map((t) => {
    // Cards carry no hands, but assert anyway so a future layout change cannot
    // quietly start covering a signer.
    assertOverlayLegal(segment, t.yPx, t.yPx + t.fontSize, `card text on ${segment.kind}`);
    return [
      `drawtext=fontfile='${esc(fontFile)}'`,
      `textfile='${esc(t.file)}'`,
      `fontsize=${t.fontSize}`,
      `fontcolor=${hexToFfmpeg(t.color)}`,
      'x=(w-text_w)/2',
      `y=${t.yPx}`,
      'line_spacing=14',
      // Comma inside the expression must be backslash-escaped: drawtext's own
      // option list is colon-separated, but the enclosing filter chain still
      // splits on comma, and min(...) needs one. Fades in over the card's
      // first 0.35s — `t` is local to this segment's own lavfi input, not the
      // whole timeline, so every card gets its own quiet entrance.
      "alpha='min(t/0.35\,1)'",
      // Not 'text_shaping': that drawtext option only exists on some
      // libfreetype/harfbuzz builds (present on FFmpeg 6.1 here, absent on a
      // stock FFmpeg 9 + Homebrew ffmpeg-full build) and fails hard with
      // "Option not found" when missing. Korean glyphs render fine without it.
    ].join(':');
  });

  return { background: hexToFfmpeg(ground), drawtexts };
}

export async function renderShort(opts: RenderOptions): Promise<RenderResult> {
  const vid = videoConfig();
  const { width, height, fps } = vid.canvas;
  const { timeline, outputFile, workDir, assFile, mode } = opts;
  const fontFile = koreanFontFile();

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  // Placement legality is proven before a single frame is encoded.
  computeBurnInBand();
  fs.writeFileSync(assFile, buildAss(timeline), 'utf8');

  const inputs: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];
  let inputIndex = 0;

  timeline.segments.forEach((segment, i) => {
    const d = segment.durationSeconds.toFixed(3);
    const label = `v${i}`;
    labels.push(`[${label}]`);

    if (segment.sourceKind === 'generated-card' || segment.sourceKind === 'placeholder') {
      const { background, drawtexts } = cardFilters(segment, i, workDir, fontFile);
      inputs.push('-f', 'lavfi', '-t', d, '-i', `color=c=${background}:s=${width}x${height}:r=${fps}`);
      const chain = [`fps=${fps}`, 'setsar=1', ...drawtexts, 'format=yuv420p'].join(',');
      filters.push(`[${inputIndex}:v]${chain}[${label}]`);
    } else if (segment.sourceKind === 'image') {
      inputs.push('-loop', '1', '-t', d, '-i', segment.sourceFile!);
      const chain = [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
        `fps=${fps}`,
        'setsar=1',
        'format=yuv420p',
      ].join(',');
      filters.push(`[${inputIndex}:v]${chain}[${label}]`);
    } else {
      // Real footage. KSL clips are fitted, never cropped: a crop can amputate
      // part of the sign. B-roll may be cropped to fill, it holds no hands.
      const isSigning = segment.protectsSigningSpace;
      inputs.push('-ss', segment.sourceInPointSeconds.toFixed(3), '-t', d, '-i', segment.sourceFile!);

      // Duration handling first — hold the last frame if the source is a hair
      // short, so the sign is never sped up or cut mid-motion to hit a
      // duration — then everyone downstream works with a clean, on-time base.
      const base = [
        `tpad=stop_mode=clone:stop_duration=${d}`,
        `trim=duration=${d}`,
        'setpts=PTS-STARTPTS',
        `fps=${fps}`,
        'setsar=1',
      ].join(',');
      filters.push(`[${inputIndex}:v]${base}[v${i}base]`);

      if (isSigning) {
        // KCISA/사전 clips are often a small fixed size (e.g. 700×466) and
        // letterboxing them onto a flat colour reads as a small window
        // floating in a box. Fill the frame with a blurred, darkened copy of
        // the same footage instead — the sign itself stays untouched, fitted
        // and uncropped, just with a full-bleed backdrop behind it.
        filters.push(`[v${i}base]split=2[v${i}bgsrc][v${i}fgsrc]`);
        filters.push(
          [
            `[v${i}bgsrc]scale=${width}:${height}:force_original_aspect_ratio=increase`,
            `crop=${width}:${height}`,
            'gblur=sigma=42',
            'eq=brightness=-0.12:saturation=0.75',
          ].join(',') + `[v${i}bg]`,
        );
        filters.push(
          `[v${i}fgsrc]scale=${width}:${height}:force_original_aspect_ratio=decrease[v${i}fg]`,
        );
        filters.push(
          `[v${i}bg][v${i}fg]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1,format=yuv420p[${label}]`,
        );
      } else {
        filters.push(
          [
            `[v${i}base]scale=${width}:${height}:force_original_aspect_ratio=increase`,
            `crop=${width}:${height}`,
            'setsar=1',
            'format=yuv420p',
          ].join(',') + `[${label}]`,
        );
      }
    }
    inputIndex += 1;
  });

  const total = timeline.totalSeconds;
  const fade = vid.transitions.fadeSeconds;

  filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[vcat]`);
  filters.push(
    `[vcat]subtitles=filename='${esc(assFile)}':fontsdir='${esc(path.dirname(fontFile))}'[vsub]`,
  );
  filters.push(
    `[vsub]fade=t=in:st=0:d=${fade},fade=t=out:st=${(total - fade).toFixed(3)}:d=${fade}[vout]`,
  );

  // Audio. Music is optional and quiet; silence is a legitimate result because
  // these videos must read with the sound off.
  if (timeline.musicFile) {
    inputs.push('-stream_loop', '-1', '-i', timeline.musicFile);
    filters.push(
      [
        `[${inputIndex}:a]atrim=duration=${total.toFixed(3)}`,
        'asetpts=PTS-STARTPTS',
        `volume=${vid.audio.musicGainDb}dB`,
        'afade=t=in:st=0:d=0.6',
        `afade=t=out:st=${Math.max(0, total - 1).toFixed(3)}:d=1`,
        `loudnorm=I=${vid.encode.loudnormIntegrated}:TP=${vid.encode.loudnormTruePeak}:LRA=${vid.encode.loudnormRange}`,
        `aresample=${vid.encode.audioSampleRate}`,
      ].join(',') + '[aout]',
    );
  } else {
    inputs.push(
      '-f',
      'lavfi',
      '-t',
      total.toFixed(3),
      '-i',
      `anullsrc=r=${vid.encode.audioSampleRate}:cl=stereo`,
    );
    filters.push(`[${inputIndex}:a]asetpts=PTS-STARTPTS[aout]`);
  }
  inputIndex += 1;

  // The graph is passed inline rather than via -filter_complex_script: that
  // option was removed in FFmpeg 9, and inline works on every version. A
  // pretty-printed copy is still written to disk purely for debugging.
  const filterGraph = filters.join(';');
  const filterFile = path.join(workDir, 'filtergraph.txt');
  fs.writeFileSync(filterFile, filters.join(';\n'), 'utf8');

  const args = [
    '-hide_banner',
    '-y',
    ...inputs,
    '-filter_complex',
    filterGraph,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    vid.encode.videoCodec,
    '-preset',
    vid.encode.preset,
    '-crf',
    String(vid.encode.crf),
    '-profile:v',
    vid.encode.profile,
    '-level',
    vid.encode.level,
    '-pix_fmt',
    vid.encode.pixelFormat,
    '-r',
    String(fps),
    '-c:a',
    vid.encode.audioCodec,
    '-b:a',
    vid.encode.audioBitrate,
    '-ar',
    String(vid.encode.audioSampleRate),
    '-t',
    total.toFixed(3),
    ...(vid.encode.faststart ? ['-movflags', '+faststart'] : []),
    outputFile,
  ];

  log.info(`ffmpeg: ${timeline.segments.length} segments → ${rel(outputFile)} (${total.toFixed(1)}s, ${mode})`);
  const result = await run(ffmpegBin(), args, 900_000);
  if (result.code !== 0) {
    const tail = result.stderr.trim().split('\n').slice(-25).join('\n');
    throw new Error(`ffmpeg failed (exit ${result.code}):\n${tail}\n\nFilter graph: ${filterFile}`);
  }
  log.ok(`rendered ${rel(outputFile)}`);

  const thumbnailFile = await renderThumbnail(timeline, outputFile);
  return {
    outputFile,
    thumbnailFile,
    ffmpegCommand: `${ffmpegBin()} ${args.join(' ')}`,
    durationSeconds: total,
  };
}

/**
 * Thumbnail from the signing moment when there is one — a real person signing is
 * the honest cover for this channel. Otherwise the hook card.
 */
export async function renderThumbnail(timeline: Timeline, videoFile: string): Promise<string> {
  const vid = videoConfig();
  const signing = timeline.segments.find((s) => s.sourceKind === 'ksl-clip');
  const chosen = signing ?? timeline.segments[0]!;
  const at = Math.max(0.1, chosen.startSeconds + chosen.durationSeconds / 2);
  const thumb = path.join(path.dirname(videoFile), 'thumbnail.jpg');
  const r = await run(
    ffmpegBin(),
    [
      '-hide_banner',
      '-y',
      '-ss',
      at.toFixed(3),
      '-i',
      videoFile,
      '-frames:v',
      '1',
      '-vf',
      `scale=${vid.canvas.width}:${vid.canvas.height}`,
      '-q:v',
      '2',
      thumb,
    ],
    120_000,
  );
  if (r.code !== 0) throw new Error(`thumbnail extraction failed: ${r.stderr.trim().split('\n').slice(-8).join('\n')}`);
  log.ok(`thumbnail from ${chosen.kind} @ ${at.toFixed(1)}s → ${rel(thumb)}`);
  return thumb;
}
