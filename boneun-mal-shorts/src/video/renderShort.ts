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

/**
 * Typographic card for beats with no footage. Korean big, English small beneath.
 * Deliberately plain: solid ground, one accent, no gradient, no motion.
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

  if (isPlaceholder) {
    texts.push({
      file: writeTextFile(workDir, `seg${index}-notice`, segment.placeholderNotice ?? ''),
      fontSize: 54,
      color: secondary,
      yPx: blockCenter - 120,
    });
    texts.push({
      file: writeTextFile(workDir, `seg${index}-ko`, segment.textKo),
      fontSize: koSize,
      color: ink,
      yPx: blockCenter,
    });
    texts.push({
      file: writeTextFile(
        workDir,
        `seg${index}-en`,
        'Record this sign with a real signer before publishing.',
      ),
      fontSize: 38,
      color: color('stone'),
      yPx: blockCenter + 150,
    });
  } else {
    if (segment.textKo.trim()) {
      texts.push({
        file: writeTextFile(workDir, `seg${index}-ko`, segment.textKo.trim()),
        fontSize: koSize,
        color: ink,
        yPx: blockCenter,
      });
    }
    if (segment.textEn.trim()) {
      texts.push({
        file: writeTextFile(workDir, `seg${index}-en`, segment.textEn.trim().toUpperCase()),
        fontSize: enSize,
        color: isEnding ? secondary : color('stone'),
        yPx: blockCenter + Math.round(koSize * 1.15),
      });
    }
    if (isEnding && b.ending.showDescriptor) {
      texts.push({
        file: writeTextFile(workDir, `seg${index}-desc`, b.descriptor),
        fontSize: hierarchy['descriptorSizePx'] ?? 30,
        color: color('stone'),
        yPx: blockCenter + Math.round(koSize * 1.15) + 80,
      });
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
      'text_shaping=1',
      'line_spacing=14',
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
      const fit = isSigning
        ? [
            `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
            `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${hexToFfmpeg(color('inkBlack'))}`,
          ]
        : [
            `scale=${width}:${height}:force_original_aspect_ratio=increase`,
            `crop=${width}:${height}`,
          ];
      const chain = [
        ...fit,
        `fps=${fps}`,
        'setsar=1',
        // Hold the last frame if the source is a hair short, so the sign is
        // never sped up or cut mid-motion to hit a duration.
        `tpad=stop_mode=clone:stop_duration=${d}`,
        `trim=duration=${d}`,
        'setpts=PTS-STARTPTS',
        'format=yuv420p',
      ].join(',');
      filters.push(`[${inputIndex}:v]${chain}[${label}]`);
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
