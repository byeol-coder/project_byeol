import { brand, content as contentConfig, video as videoConfig } from '../util/config.js';
import { log } from '../util/log.js';
import { readJson } from '../util/json.js';
import { P } from '../util/paths.js';
import { rotationHistory } from './selectTopic.js';
import type { Commercial, ContentScript, SeriesName, TopicSeed } from '../types.js';

// ---------------------------------------------------------------------------
// Copy assembly.
//
// This does NOT write Korean from scratch and it never writes sign language.
// Lines come from human-authored seeds in data/topics.json; this module chooses
// a structure, keeps the lines short, and refuses anything on the banned list.
// Korean is primary, English is a secondary subtitle — not a literal gloss.
// ---------------------------------------------------------------------------

export interface GenerateInput {
  topic: TopicSeed;
  /** Overrides the seed's series; normally left alone. */
  series?: SeriesName;
  /** Words confirmed by KCISA *and* backed by a verified clip. */
  verifiedWords?: string[];
}

/** English gloss shown under a sign. Human-authored; empty when we have none. */
export function signGloss(word: string): string {
  const file = readJson<{ glosses?: Record<string, string> }>(P.signGlosses, {});
  return file.glosses?.[word] ?? '';
}

/** Deterministic small hash, so the same topic doesn't flip structure per run. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

type StructureVariant = 'hook-first' | 'cold-open' | 'question-answer';
const VARIANTS: StructureVariant[] = ['hook-first', 'cold-open', 'question-answer'];

/** Pick a structure that differs from the previous video's, to avoid a house format. */
export function pickVariant(topicId: string): StructureVariant {
  const history = rotationHistory();
  const previous = history.at(-1)?.slug ?? '';
  const base = VARIANTS[hash(topicId) % VARIANTS.length]!;
  if (!previous) return base;
  const previousVariant = VARIANTS.find((v) => previous.includes(v));
  if (previousVariant && previousVariant === base) {
    return VARIANTS[(VARIANTS.indexOf(base) + 1) % VARIANTS.length]!;
  }
  return base;
}

function stripped(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}

export interface CopyViolation {
  where: string;
  phrase: string;
  line: string;
}

/**
 * Hard gate on the tone rules. If this trips, rewrite the seed copy — do not
 * relax the banned list. Clickbait and inspiration-porn phrasing are not style
 * preferences here, they are brand failures.
 */
export function findCopyViolations(script: {
  hookKo: string;
  hookEn: string;
  bodyKo: string[];
  bodyEn: string[];
  pointKo: string;
  pointEn: string;
  ctaKo: string;
  ctaEn: string;
}): CopyViolation[] {
  const cfg = contentConfig().copy;
  const violations: CopyViolation[] = [];
  const check = (where: string, lines: string[], banned: string[]) => {
    for (const line of lines) {
      if (!line) continue;
      for (const phrase of banned) {
        if (stripped(line).includes(stripped(phrase))) {
          violations.push({ where, phrase, line });
        }
      }
    }
  };
  check('hook', [script.hookKo, script.hookEn], [...cfg.bannedHookPhrases, ...cfg.bannedBodyPhrases]);
  check('body', [...script.bodyKo, ...script.bodyEn], cfg.bannedBodyPhrases);
  check('point', [script.pointKo, script.pointEn], cfg.bannedBodyPhrases);
  check('cta', [script.ctaKo, script.ctaEn], [...cfg.bannedCtaPhrases, ...cfg.bannedBodyPhrases]);
  return violations;
}

/** Split an over-long line at a natural break instead of truncating meaning. */
function wrap(line: string, maxChars: number): string[] {
  const text = line.trim();
  if (!text || text.length <= maxChars) return text ? [text] : [];
  const out: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= maxChars) current = `${current} ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out;
}

function dropAdjacentDuplicates(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const previous = out.at(-1);
    if (previous) {
      const a = stripped(previous);
      const b = stripped(line);
      if (a === b || a.includes(b) || b.includes(a)) {
        // Keep the longer of the two: it carries more of the sentence.
        if (b.length > a.length) out[out.length - 1] = line;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

function commercialFrom(topic: TopicSeed): Commercial {
  const defaults = contentConfig().monetizationDefaults;
  const isCommercial = topic.commercial ?? defaults.commercial;
  const isAffiliate = topic.affiliate ?? defaults.affiliate;
  const sponsor = topic.sponsor ?? defaults.sponsor;
  const product = topic.product ?? defaults.product;
  const needsDisclosure = isCommercial || isAffiliate || Boolean(sponsor);
  return {
    commercial: isCommercial,
    affiliate: isAffiliate,
    sponsor,
    product,
    disclosureKo: needsDisclosure
      ? isAffiliate && !isCommercial
        ? '이 영상에는 제휴 링크가 포함되어 있습니다.'
        : `유료 광고 포함${sponsor ? ` · ${sponsor}` : ''}`
      : null,
    disclosureEn: needsDisclosure
      ? isAffiliate && !isCommercial
        ? 'This video contains affiliate links.'
        : `Paid promotion${sponsor ? ` · ${sponsor}` : ''}`
      : null,
  };
}

export function generateContent(input: GenerateInput): ContentScript {
  const cfg = contentConfig();
  const vid = videoConfig();
  const b = brand();
  const topic = input.topic;
  const series = input.series ?? topic.series;
  const seriesCfg = cfg.series[series];
  if (!seriesCfg) throw new Error(`Unknown series "${series}" — check config/content.json`);

  const seed = topic.copy ?? {};

  // The featured sign: prefer one that is actually verified, so the script never
  // depends on a sign we cannot legitimately show.
  const candidates = topic.kslWords;
  if (candidates.length === 0) {
    throw new Error(`Topic "${topic.topic}" declares no kslWords — nothing to verify or show.`);
  }
  const verified = input.verifiedWords ?? [];
  const kslWord = candidates.find((w) => verified.includes(w)) ?? candidates[0]!;
  if (verified.length && !verified.includes(kslWord)) {
    log.warn(`no verified clip among [${candidates.join(', ')}] — script keeps "${kslWord}" as the target sign`);
  }

  const variant = pickVariant(topic.id);

  const hookKo = (seed.hookKo ?? `${topic.topic}.`).trim();
  const hookEn = (seed.hookEn ?? '').trim();
  const beatsKo = (seed.beatsKo ?? [`${topic.topic}.`]).map((s) => s.trim()).filter(Boolean);
  const beatsEn = (seed.beatsEn ?? []).map((s) => s.trim()).filter(Boolean);
  const pointKo = (seed.pointKo ?? '').trim();
  const pointEn = (seed.pointEn ?? '').trim();
  const ctaKo = (seed.ctaKo ?? '').trim();
  const ctaEn = (seed.ctaEn ?? '').trim();

  // Variation is structural, not textual: the beats stay in the order a human
  // wrote them, and the variant decides where the sign lands relative to them
  // (see src/video/timeline.ts). Nothing here paraphrases Korean.
  let bodyKo = beatsKo.flatMap((l) => wrap(l, cfg.copy.maxLineCharsKo));
  let bodyEn = beatsEn.flatMap((l) => wrap(l, cfg.copy.maxLineCharsEn));

  // Safety net: a seed edit that leaves one line contained in its neighbour
  // would otherwise read as a stutter on screen.
  bodyKo = dropAdjacentDuplicates(bodyKo);
  bodyEn = dropAdjacentDuplicates(bodyEn);

  if (hookKo.length > cfg.copy.maxHookCharsKo) {
    log.warn(
      `hook is ${hookKo.length} chars (max ${cfg.copy.maxHookCharsKo}); it will be split across two cues`,
    );
  }

  const script: ContentScript = {
    topicId: topic.id,
    topic: topic.topic,
    series,
    hookKo,
    hookEn,
    bodyKo,
    bodyEn,
    kslWord,
    kslWords: candidates,
    pointKo,
    pointEn,
    endingKo: b.brandNameKo,
    endingEn: b.brandNameEn,
    ctaKo,
    ctaEn,
    durationTarget: Math.min(
      vid.duration.maxSeconds,
      Math.max(vid.duration.minSeconds, seriesCfg.durationTargetSeconds),
    ),
    structureVariant: variant,
    commercial: commercialFrom(topic),
  };

  const violations = findCopyViolations(script);
  if (violations.length) {
    const detail = violations
      .map((v) => `  · ${v.where}: banned phrase "${v.phrase}" in "${v.line}"`)
      .join('\n');
    throw new Error(
      `Copy violates the tone rules and will not be rendered:\n${detail}\n` +
        'Rewrite the seed lines in data/topics.json. Do not relax config/content.json.',
    );
  }

  if (script.commercial.disclosureKo) {
    log.warn(
      `commercial content — disclosure will be written into metadata and the description: ${script.commercial.disclosureKo}`,
    );
  }

  log.ok(`script built (${variant}, target ${script.durationTarget}s, sign "${script.kslWord}")`);
  return script;
}

/** Plain-text script files for the output folder. */
export function scriptToText(script: ContentScript, lang: 'ko' | 'en'): string {
  const b = brand();
  const isKo = lang === 'ko';
  const lines = [
    `${b.brandNameKo} / ${b.brandNameEn}`,
    b.descriptor,
    '',
    `${isKo ? '주제' : 'Topic'}: ${script.topic}`,
    `${isKo ? '시리즈' : 'Series'}: ${script.series}`,
    `${isKo ? '구성' : 'Structure'}: ${script.structureVariant}`,
    `${isKo ? '수어' : 'Sign'}: ${script.kslWord} (KSL)`,
    `${isKo ? '목표 길이' : 'Target length'}: ${script.durationTarget}s`,
    '',
    `--- ${isKo ? 'HOOK' : 'HOOK'} ---`,
    isKo ? script.hookKo : script.hookEn || '(no English hook)',
    '',
    `--- ${isKo ? '본문' : 'BODY'} ---`,
    ...(isKo ? script.bodyKo : script.bodyEn),
    '',
    `--- ${isKo ? '수어' : 'SIGN'} ---`,
    isKo
      ? `실제 사람이 녹화한 검증된 KSL 클립: ${script.kslWord}`
      : `Verified human-recorded KSL clip: ${script.kslWord}`,
    '',
  ];
  const point = isKo ? script.pointKo : script.pointEn;
  if (point) lines.push(`--- ${isKo ? '의미' : 'POINT'} ---`, point, '');
  const cta = isKo ? script.ctaKo : script.ctaEn;
  if (cta) lines.push(`--- CTA ---`, cta, '');
  const disclosure = isKo ? script.commercial.disclosureKo : script.commercial.disclosureEn;
  if (disclosure) lines.push(`--- ${isKo ? '고지' : 'DISCLOSURE'} ---`, disclosure, '');
  lines.push(`--- ${isKo ? '엔딩' : 'ENDING'} ---`, `${script.endingKo} / ${script.endingEn}`, b.descriptor, '');
  return lines.join('\n');
}
