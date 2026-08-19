import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.js';
import { readJson } from './json.js';
import { env } from './env.js';
import type { SeriesName } from '../types.js';

export interface BrandConfig {
  brandNameKo: string;
  brandNameEn: string;
  descriptor: string;
  descriptorKo: string;
  handle: string;
  colors: Record<string, string>;
  accentPolicy: { maxAccentColorsPerVideo: number; defaultAccent: string; alternateAccent: string };
  typography: {
    koreanFontFamily: string;
    koreanFontFileCandidates: string[];
    latinFontFamily: string;
    hierarchy: Record<string, number | boolean>;
  };
  ending: { minSeconds: number; maxSeconds: number; showDescriptor: boolean };
  tone: { avoid: string[]; aim: string[] };
}

export interface VideoConfig {
  canvas: { width: number; height: number; aspect: string; fps: number };
  encode: {
    videoCodec: string;
    pixelFormat: string;
    preset: string;
    crf: number;
    profile: string;
    level: string;
    audioCodec: string;
    audioBitrate: string;
    audioSampleRate: number;
    loudnormIntegrated: number;
    loudnormTruePeak: number;
    loudnormRange: number;
    faststart: boolean;
  };
  duration: { minSeconds: number; maxSeconds: number; defaultTargetSeconds: number };
  safeArea: { topPx: number; bottomPx: number; leftPx: number; rightPx: number };
  signingSpace: {
    topPx: number;
    bottomPx: number;
    leftPx: number;
    rightPx: number;
    minVisibleBodyParts: string[];
  };
  subtitle: {
    burnIn: {
      enabled: boolean;
      maxKoCharsPerCue: number;
      maxEnCharsPerCue: number;
      koFontSizePx: number;
      enFontSizePx: number;
      marginBottomPx: number;
      outlinePx: number;
      shadowPx: number;
      plateOpacity: number;
      lineGapPx: number;
    };
    sidecar: { ko: string; en: string };
  };
  transitions: { allowed: string[]; fadeSeconds: number; maxFadesPerVideo: number };
  audio: {
    musicGainDb: number;
    duckUnderKslDb: number;
    requireCopyrightCleared: boolean;
    allowTts: boolean;
  };
}

export interface SeriesConfig {
  nameKo: string;
  share: number;
  intent: string;
  durationTargetSeconds: number;
  requiresDisclosureWhenCommercial?: boolean;
}

export interface ContentConfig {
  series: Record<SeriesName, SeriesConfig>;
  rotation: {
    minDaysBeforeTopicRepeat: number;
    maxSameSeriesInARow: number;
    brollNoRepeatWindow: number;
  };
  copy: {
    bannedHookPhrases: string[];
    bannedBodyPhrases: string[];
    bannedCtaPhrases: string[];
    maxHookCharsKo: number;
    maxLineCharsKo: number;
    maxLineCharsEn: number;
  };
  hashtags: { always: string[]; pool: string[]; minCount: number; maxCount: number };
  monetizationDefaults: {
    commercial: boolean;
    affiliate: boolean;
    sponsor: string | null;
    product: string | null;
  };
  youtube: {
    categoryId: string;
    defaultLanguage: string;
    defaultAudioLanguage: string;
    privacyStatus: 'private' | 'unlisted' | 'public';
    madeForKids: boolean;
  };
}

function load<T>(name: string): T {
  const file = path.join(P.config, name);
  if (!fs.existsSync(file)) throw new Error(`Missing config file: ${file}`);
  return readJson<T>(file, null as unknown as T);
}

let brandCache: BrandConfig | null = null;
let videoCache: VideoConfig | null = null;
let contentCache: ContentConfig | null = null;

export const brand = (): BrandConfig => (brandCache ??= load<BrandConfig>('brand.json'));
export const video = (): VideoConfig => (videoCache ??= load<VideoConfig>('video.json'));
export const content = (): ContentConfig => (contentCache ??= load<ContentConfig>('content.json'));

/**
 * Resolve a Korean-capable font file. Burn-in Korean text is non-negotiable, so
 * a missing font is an error rather than a silent fallback to tofu boxes.
 */
export function koreanFontFile(): string {
  const override = env('KOREAN_FONT_FILE');
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`KOREAN_FONT_FILE points at a missing file: ${override}`);
    }
    return override;
  }
  for (const candidate of brand().typography.koreanFontFileCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'No Korean-capable font found. Install one (e.g. `fonts-noto-cjk`) or set KOREAN_FONT_FILE in .env.',
  );
}

/** Brand colour by name. A missing colour is a config error, not a silent black. */
export function color(name: string): string {
  const hex = brand().colors[name];
  if (!hex) {
    throw new Error(
      `Unknown brand colour "${name}". Available: ${Object.keys(brand().colors).join(', ')} (config/brand.json)`,
    );
  }
  return hex;
}

export function koreanFontFileOrNull(): string | null {
  try {
    return koreanFontFile();
  } catch {
    return null;
  }
}
