import { brand, content as contentConfig, video as videoConfig } from '../util/config.js';
import { log } from '../util/log.js';
import { rel } from '../util/paths.js';
import { recentlyUsedBroll } from '../content/selectTopic.js';
import { signGloss } from '../content/generateContent.js';
import { discoverBroll, discoverMusic, pickBroll } from './assets.js';
import type { ContentScript, KslMatch, Timeline, TimelineSegment } from '../types.js';

// ---------------------------------------------------------------------------
// Timeline construction.
//
// Shape is 0–2s hook / context / sign / cultural point / brand ending, but the
// order varies with the script's structure variant so consecutive videos don't
// look stamped from one template. The signing segment always gets the time it
// needs first; everything else absorbs the remainder.
// ---------------------------------------------------------------------------

export const PLACEHOLDER_NOTICE = '[ VERIFIED KSL CLIP REQUIRED ]';

export interface BuildTimelineInput {
  script: ContentScript;
  matches: KslMatch[];
  mode: 'render' | 'preview';
  brollTags: string[];
}

interface Beat {
  kind: TimelineSegment['kind'];
  textKo: string;
  textEn: string;
  /** Fixed length; when absent the beat shares the leftover time. */
  fixedSeconds?: number;
  minSeconds: number;
  isSigning?: boolean;
  match?: KslMatch;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function buildTimeline(input: BuildTimelineInput): Timeline {
  const vid = videoConfig();
  const cfg = contentConfig();
  const b = brand();
  const { script, matches, mode } = input;

  const signMatch =
    matches.find((m) => m.word === script.kslWord) ?? matches.find((m) => m.status === 'VERIFIED') ?? null;

  const isVerified = signMatch?.status === 'VERIFIED' && Boolean(signMatch.clip);
  if (!isVerified && mode === 'render') {
    throw new Error(
      `No verified KSL clip for "${script.kslWord}" — refusing to render a publishable video. ` +
        'Use `npm run shorts:preview` to produce a placeholder preview, or record the sign first.',
    );
  }

  // The sign gets as long as the real clip runs (clamped so a long take doesn't
  // eat the whole short). Nothing is sped up or trimmed mid-sign.
  const clipDuration = signMatch?.clip?.durationSeconds ?? null;
  const signSeconds = clipDuration ? clamp(clipDuration, 2.5, 9) : 4;
  if (clipDuration && clipDuration > 9) {
    log.warn(
      `clip for "${script.kslWord}" is ${clipDuration.toFixed(1)}s; only the first 9s is used. ` +
        'Trim the recording so the whole sign fits.',
    );
  }

  const endingSeconds = clamp(1.0, b.ending.minSeconds, b.ending.maxSeconds);

  const hookBeat: Beat = {
    kind: 'hook',
    textKo: script.hookKo,
    textEn: script.hookEn,
    fixedSeconds: 2.0,
    minSeconds: 1.6,
  };
  const signBeat: Beat = {
    kind: 'ksl',
    textKo: script.kslWord,
    // The English line under a sign is a gloss, not a translation of its grammar.
    textEn: signGloss(script.kslWord),
    fixedSeconds: signSeconds,
    minSeconds: 2.5,
    isSigning: true,
    ...(signMatch ? { match: signMatch } : {}),
  };
  const contextBeats: Beat[] = script.bodyKo.map((line, i) => ({
    kind: 'context',
    textKo: line,
    textEn: script.bodyEn[i] ?? '',
    minSeconds: 1.3,
  }));
  const pointBeats: Beat[] = script.pointKo || script.pointEn
    ? [
        {
          kind: 'point',
          textKo: script.pointKo,
          textEn: script.pointEn,
          minSeconds: 2.0,
        },
      ]
    : [];
  const ctaBeats: Beat[] = script.ctaKo || script.ctaEn
    ? [{ kind: 'point', textKo: script.ctaKo, textEn: script.ctaEn, minSeconds: 1.4 }]
    : [];
  const endingBeat: Beat = {
    kind: 'ending',
    textKo: script.endingKo,
    textEn: script.endingEn,
    fixedSeconds: endingSeconds,
    minSeconds: b.ending.minSeconds,
  };

  let ordered: Beat[];
  switch (script.structureVariant) {
    case 'cold-open':
      ordered = [signBeat, hookBeat, ...contextBeats, ...pointBeats, ...ctaBeats, endingBeat];
      break;
    case 'question-answer':
      ordered = [hookBeat, ...contextBeats, signBeat, ...pointBeats, ...ctaBeats, endingBeat];
      break;
    case 'hook-first':
    default:
      ordered = [hookBeat, ...contextBeats.slice(0, 1), signBeat, ...contextBeats.slice(1), ...pointBeats, ...ctaBeats, endingBeat];
      break;
  }
  ordered = ordered.filter((beat) => beat.isSigning || beat.textKo || beat.textEn);

  // Distribute time: fixed beats first, remainder split across the flexible ones.
  const target = clamp(script.durationTarget, vid.duration.minSeconds, vid.duration.maxSeconds);
  const fixedTotal = ordered.reduce((acc, s) => acc + (s.fixedSeconds ?? 0), 0);
  const flexible = ordered.filter((s) => s.fixedSeconds === undefined);
  const flexMinTotal = flexible.reduce((acc, s) => acc + s.minSeconds, 0);
  let flexBudget = target - fixedTotal;

  if (flexBudget < flexMinTotal) {
    log.warn(
      `target ${target}s is tight for ${ordered.length} beats; extending to fit minimum readable durations`,
    );
    flexBudget = flexMinTotal;
  }

  const perFlex = flexible.length ? flexBudget / flexible.length : 0;

  const brollAssets = discoverBroll();
  const recentBroll = recentlyUsedBroll();
  const takenThisVideo = new Set<string>();
  const brollUsed: string[] = [];

  const segments: TimelineSegment[] = [];
  let cursor = 0;
  for (const beat of ordered) {
    const duration =
      beat.fixedSeconds ?? Math.max(beat.minSeconds, Number(perFlex.toFixed(3)));

    let sourceFile: string | null = null;
    let sourceKind: TimelineSegment['sourceKind'] = 'generated-card';
    let placeholderNotice: string | null = null;

    if (beat.isSigning) {
      if (isVerified && signMatch?.clip) {
        sourceFile = signMatch.clip.file;
        sourceKind = 'ksl-clip';
      } else {
        sourceKind = 'placeholder';
        placeholderNotice = PLACEHOLDER_NOTICE;
      }
    } else if (beat.kind !== 'ending') {
      const chosen = pickBroll(brollAssets, input.brollTags, recentBroll, takenThisVideo);
      if (chosen) {
        sourceFile = chosen.file;
        sourceKind = chosen.kind === 'image' ? 'image' : 'broll';
        takenThisVideo.add(chosen.file);
        brollUsed.push(chosen.file);
        log.debug(`${beat.kind}: b-roll ${rel(chosen.file)}`);
      }
    }

    segments.push({
      kind: beat.kind,
      startSeconds: Number(cursor.toFixed(3)),
      durationSeconds: Number(duration.toFixed(3)),
      sourceFile,
      sourceKind,
      // Only real footage of a signer needs the signing space kept clear. A
      // placeholder card has no hands to cover — and saying so explicitly is
      // what lets the notice sit in the middle of the frame.
      protectsSigningSpace: sourceKind === 'ksl-clip',
      textKo: beat.textKo,
      textEn: beat.textEn,
      placeholderNotice,
      sourceInPointSeconds: 0,
    });
    cursor += duration;
  }

  const totalSeconds = Number(cursor.toFixed(3));
  if (totalSeconds > vid.duration.maxSeconds) {
    throw new Error(
      `Timeline is ${totalSeconds.toFixed(1)}s, over the ${vid.duration.maxSeconds}s ceiling. ` +
        'Cut a body line in data/topics.json rather than speeding anything up.',
    );
  }
  if (totalSeconds < vid.duration.minSeconds) {
    log.warn(
      `timeline is ${totalSeconds.toFixed(1)}s, under the ${vid.duration.minSeconds}s floor — add a body line`,
    );
  }

  const music = discoverMusic();
  const chosenMusic = music[0] ?? null;
  if (!chosenMusic) {
    log.info('no rights-cleared music available — rendering silent (these videos read without sound)');
  }

  if (brollUsed.length === 0) {
    log.info(
      'no B-roll available — non-signing beats render as typographic brand cards (no AI footage is generated)',
    );
  } else if (brollUsed.length < segments.filter((s) => s.sourceKind === 'broll').length) {
    log.debug(`b-roll no-repeat window: ${cfg.rotation.brollNoRepeatWindow} video(s)`);
  }

  log.ok(
    `timeline: ${segments.length} segments, ${totalSeconds.toFixed(1)}s (${script.structureVariant})`,
  );
  for (const s of segments) {
    log.debug(
      `  ${s.startSeconds.toFixed(2)}s +${s.durationSeconds.toFixed(2)}s ${s.kind.padEnd(8)} ${s.sourceKind}${s.protectsSigningSpace ? ' [signing space protected]' : ''}`,
    );
  }

  return {
    totalSeconds,
    segments,
    musicFile: chosenMusic?.file ?? null,
    musicAttribution: chosenMusic
      ? chosenMusic.attributionRequired
        ? chosenMusic.attributionText || `${chosenMusic.title} — ${chosenMusic.artist} (${chosenMusic.license})`
        : ''
      : null,
    brollUsed,
  };
}
