import { brand, color, video as videoConfig } from '../util/config.js';
import { log } from '../util/log.js';
import type { Timeline, TimelineSegment } from '../types.js';

// ---------------------------------------------------------------------------
// Captions.
//
// Two sidecar SRTs are always produced (ko + en). Burn-in is deliberately
// minimal: a short Korean line, a smaller English line, placed in the band
// between the signing space and the Shorts UI reserve. Nothing burned in may
// enter the signing space — that is asserted, not assumed.
// ---------------------------------------------------------------------------

export interface BurnInBand {
  koTopPx: number;
  koBottomPx: number;
  koMarginVPx: number;
  enTopPx: number;
  enBottomPx: number;
  enMarginVPx: number;
}

/** ASS `fs` is an em size; the line box is roughly 1.2em. */
const LINE_BOX = 1.2;

export interface BandGeometry {
  height: number;
  koFontSizePx: number;
  enFontSizePx: number;
  lineGapPx: number;
  marginBottomPx: number;
  signingSpaceBottomPx: number;
  uiReserveBottomPx: number;
}

/**
 * Work out where the two burn-in lines sit, and prove the placement is legal:
 * below the signing space, above the Shorts UI reserve. Pure, so the constraint
 * itself is testable without touching config files.
 */
export function computeBurnInBandFrom(g: BandGeometry): BurnInBand {
  const height = g.height;
  const bi = {
    koFontSizePx: g.koFontSizePx,
    enFontSizePx: g.enFontSizePx,
    lineGapPx: g.lineGapPx,
    marginBottomPx: g.marginBottomPx,
  };
  const koBox = Math.round(bi.koFontSizePx * LINE_BOX);
  const enBox = Math.round(bi.enFontSizePx * LINE_BOX);

  const enMarginVPx = bi.marginBottomPx;
  const enBottomPx = height - enMarginVPx;
  const enTopPx = enBottomPx - enBox;

  const koMarginVPx = enMarginVPx + enBox + bi.lineGapPx;
  const koBottomPx = height - koMarginVPx;
  const koTopPx = koBottomPx - koBox;

  const band = { koTopPx, koBottomPx, koMarginVPx, enTopPx, enBottomPx, enMarginVPx };

  const signingBottom = g.signingSpaceBottomPx;
  const uiReserveTop = height - g.uiReserveBottomPx;
  if (koTopPx < signingBottom) {
    throw new Error(
      `Burn-in subtitles would enter the signing space (Korean line top ${koTopPx}px < ` +
        `signingSpace.bottomPx ${signingBottom}px). Lower the font sizes or raise ` +
        'subtitle.burnIn.marginBottomPx in config/video.json. Hands are never covered.',
    );
  }
  if (enBottomPx > uiReserveTop) {
    throw new Error(
      `Burn-in subtitles would collide with the Shorts UI reserve (English line bottom ` +
        `${enBottomPx}px > ${uiReserveTop}px). Increase subtitle.burnIn.marginBottomPx.`,
    );
  }
  log.debug(
    `burn-in band: KO ${koTopPx}–${koBottomPx}px, EN ${enTopPx}–${enBottomPx}px ` +
      `(signing space ends ${signingBottom}px, UI reserve starts ${uiReserveTop}px)`,
  );
  return band;
}

export function computeBurnInBand(): BurnInBand {
  const vid = videoConfig();
  const bi = vid.subtitle.burnIn;
  return computeBurnInBandFrom({
    height: vid.canvas.height,
    koFontSizePx: bi.koFontSizePx,
    enFontSizePx: bi.enFontSizePx,
    lineGapPx: bi.lineGapPx,
    marginBottomPx: bi.marginBottomPx,
    signingSpaceBottomPx: vid.signingSpace.bottomPx,
    uiReserveBottomPx: vid.safeArea.bottomPx,
  });
}

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const msPart = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(msPart, 3)}`;
}

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const csPart = cs % 100;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${h}:${p(m)}:${p(s)}.${p(csPart)}`;
}

export interface Cue {
  startSeconds: number;
  endSeconds: number;
  textKo: string;
  textEn: string;
}

/** One cue per segment that carries words. The brand ending is not a caption. */
export function timelineToCues(timeline: Timeline): Cue[] {
  return timeline.segments
    .filter((s) => s.kind !== 'ending' && (s.textKo || s.textEn))
    .map((s) => ({
      startSeconds: s.startSeconds,
      endSeconds: s.startSeconds + s.durationSeconds,
      textKo: s.textKo,
      textEn: s.textEn,
    }));
}

export function buildSrt(cues: Cue[], lang: 'ko' | 'en'): string {
  const blocks: string[] = [];
  let n = 0;
  for (const cue of cues) {
    const text = lang === 'ko' ? cue.textKo : cue.textEn;
    if (!text.trim()) continue;
    n += 1;
    blocks.push(
      `${n}\n${srtTime(cue.startSeconds)} --> ${srtTime(cue.endSeconds)}\n${text.trim()}\n`,
    );
  }
  if (n === 0) {
    log.warn(`no ${lang.toUpperCase()} caption lines were produced — check the topic seed copy`);
  }
  return `${blocks.join('\n')}`;
}

function assColor(hex: string): string {
  // ASS wants &HAABBGGRR.
  const h = hex.replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const bl = h.slice(4, 6);
  return `&H00${bl}${g}${r}`.toUpperCase();
}

function assEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');
}

/**
 * Burn-in subtitle track. Only segments backed by real footage get burn-in;
 * typographic cards already carry their own text, and doubling it would read as
 * a template.
 */
export function buildAss(timeline: Timeline): string {
  const vid = videoConfig();
  const b = brand();
  const bi = vid.subtitle.burnIn;
  const band = computeBurnInBand();
  const { width, height } = vid.canvas;
  const font = b.typography.koreanFontFamily;

  const primary = assColor(color('warmIvory'));
  const outline = assColor(color('inkBlack'));
  // A thin outline plus a soft shadow keeps text legible over real footage
  // without resorting to a subtitle plate that would fill the frame.
  const borderStyle = 1;
  const outlineW = bi.outlinePx;
  const shadowW = bi.shadowPx;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: KO,${font},${bi.koFontSizePx},${primary},${primary},${outline},${outline},1,0,0,0,100,100,0,0,${borderStyle},${outlineW},${shadowW},2,${vid.safeArea.leftPx},${vid.safeArea.rightPx},${band.koMarginVPx},1`,
    `Style: EN,${font},${bi.enFontSizePx},${primary},${primary},${outline},${outline},0,0,0,0,100,100,1,0,${borderStyle},${outlineW},${shadowW},2,${vid.safeArea.leftPx},${vid.safeArea.rightPx},${band.enMarginVPx},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const clip = (text: string, max: number): string =>
    text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;

  const events: string[] = [];
  const burnable = new Set(['ksl-clip', 'broll', 'image']);
  for (const seg of timeline.segments) {
    if (!burnable.has(seg.sourceKind)) continue;
    const start = assTime(seg.startSeconds);
    const end = assTime(seg.startSeconds + seg.durationSeconds);
    if (seg.textKo.trim()) {
      events.push(
        `Dialogue: 0,${start},${end},KO,,0,0,0,,${assEscape(clip(seg.textKo.trim(), bi.maxKoCharsPerCue))}`,
      );
    }
    if (seg.textEn.trim()) {
      events.push(
        `Dialogue: 0,${start},${end},EN,,0,0,0,,${assEscape(clip(seg.textEn.trim().toUpperCase(), bi.maxEnCharsPerCue))}`,
      );
    }
  }

  if (events.length === 0) log.debug('no burn-in cues (all beats are typographic cards)');
  return `${[...header, ...events].join('\n')}\n`;
}

/** Guard used by the renderer before drawing anything over footage. */
export function assertOverlayLegal(
  segment: TimelineSegment,
  topPx: number,
  bottomPx: number,
  what: string,
): void {
  const vid = videoConfig();
  if (!segment.protectsSigningSpace) return;
  const ss = vid.signingSpace;
  const overlaps = bottomPx > ss.topPx && topPx < ss.bottomPx;
  if (overlaps) {
    throw new Error(
      `${what} would be drawn at ${topPx}–${bottomPx}px on a signing segment, inside the ` +
        `signing space (${ss.topPx}–${ss.bottomPx}px). Hands and face stay visible — move it or drop it.`,
    );
  }
}
