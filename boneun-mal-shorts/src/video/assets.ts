import fs from 'node:fs';
import path from 'node:path';
import { P, rel } from '../util/paths.js';
import { readJson } from '../util/json.js';
import { log } from '../util/log.js';
import { video as videoConfig } from '../util/config.js';

// ---------------------------------------------------------------------------
// Asset discovery for B-roll, music and logos.
//
// Two rules are enforced here rather than trusted to editing discipline:
//   1. AI footage may be background/atmosphere only — never signing.
//   2. Music without a cleared-rights sidecar is not used at all.
// ---------------------------------------------------------------------------

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg']);

export interface BrollSidecar {
  location?: string;
  aiGenerated?: boolean;
  containsSigning?: boolean;
  rights?: string;
  shotAt?: string;
}

export interface BrollAsset {
  file: string;
  tag: string;
  kind: 'video' | 'image';
  sidecar: BrollSidecar | null;
}

export interface MusicAsset {
  file: string;
  title: string;
  artist: string;
  license: string;
  attributionRequired: boolean;
  attributionText: string;
}

function readSidecar<T>(file: string): T | null {
  const sc = file.replace(/\.[^.]+$/, '.json');
  if (!fs.existsSync(sc)) return null;
  try {
    return readJson<T>(sc, null as never);
  } catch (err) {
    log.warn(`unreadable sidecar for ${rel(file)}: ${(err as Error).message}`);
    return null;
  }
}

export function discoverBroll(): BrollAsset[] {
  if (!fs.existsSync(P.brollAssets)) return [];
  const out: BrollAsset[] = [];
  const walk = (dir: string, tag: string): void => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, entry.toLowerCase());
        continue;
      }
      const ext = path.extname(entry).toLowerCase();
      const kind = VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'image' : null;
      if (!kind) continue;
      const sidecar = readSidecar<BrollSidecar>(full);
      if (sidecar?.aiGenerated && sidecar?.containsSigning) {
        log.error(
          `rejected ${rel(full)}: sidecar declares AI-generated footage containing signing. ` +
            'AI must never appear to sign.',
        );
        continue;
      }
      out.push({ file: full, tag, kind, sidecar });
    }
  };
  walk(P.brollAssets, 'broll');
  return out;
}

/**
 * Choose B-roll for a set of tags, skipping anything used in the last N videos.
 * Returns null when nothing suitable exists — the renderer then falls back to a
 * typographic brand card rather than reusing a clip.
 */
export function pickBroll(
  assets: BrollAsset[],
  tags: string[],
  used: Set<string>,
  takenThisVideo: Set<string>,
): BrollAsset | null {
  const fresh = assets.filter((a) => !used.has(a.file) && !takenThisVideo.has(a.file));
  for (const tag of tags) {
    const hit = fresh.find((a) => a.tag === tag);
    if (hit) return hit;
  }
  const anyFresh = fresh[0];
  if (anyFresh) return anyFresh;
  // Everything is on the no-repeat list: prefer a card over a repeat.
  return null;
}

export function discoverMusic(): MusicAsset[] {
  if (!fs.existsSync(P.musicAssets)) return [];
  const requireCleared = videoConfig().audio.requireCopyrightCleared;
  const out: MusicAsset[] = [];
  for (const entry of fs.readdirSync(P.musicAssets)) {
    const full = path.join(P.musicAssets, entry);
    if (!fs.statSync(full).isFile()) continue;
    if (!AUDIO_EXT.has(path.extname(entry).toLowerCase())) continue;
    const sc = readSidecar<{
      title?: string;
      artist?: string;
      license?: string;
      licenseUrl?: string;
      attributionRequired?: boolean;
      attributionText?: string;
      copyrightCleared?: boolean;
    }>(full);
    if (requireCleared && !sc?.copyrightCleared) {
      log.warn(
        `skipping music ${rel(full)}: no sidecar with "copyrightCleared": true. ` +
          'Unverified music is never used.',
      );
      continue;
    }
    out.push({
      file: full,
      title: sc?.title ?? path.basename(entry),
      artist: sc?.artist ?? 'unknown',
      license: sc?.license ?? 'unspecified',
      attributionRequired: sc?.attributionRequired ?? false,
      attributionText: sc?.attributionText ?? '',
    });
  }
  return out;
}

export function findWordmark(): string | null {
  for (const name of ['wordmark.png', 'wordmark.svg', 'logo.png']) {
    const full = path.join(P.logoAssets, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}
