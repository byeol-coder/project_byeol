import fs from 'node:fs';
import path from 'node:path';
import { P, rel } from '../util/paths.js';
import { readJson } from '../util/json.js';
import { ffprobeMedia } from '../util/exec.js';
import { log } from '../util/log.js';
import type { KslClip, KslClipMetadata } from '../types.js';

// ---------------------------------------------------------------------------
// The KSL clip library. A clip counts as usable only when a human recorded it,
// consented to it, and its framing keeps face + upper body + both hands visible.
// A missing sidecar is never treated as "probably fine".
// ---------------------------------------------------------------------------

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

/**
 * Origins that describe a real human recording. AI origins are never allowed.
 * `kcisa-official-dictionary` is a recording pulled directly from the KCISA
 * getCTE01701 response (國立國語院 한국수어사전 / sldict.korean.go.kr) — a real
 * signer, government-produced, used under whatever public licence that source
 * actually carries. `npm run ksl:import` is the only thing that should ever
 * write this value, and only after a human confirmed the licence permits it.
 */
const HUMAN_SOURCES = new Set([
  'human-recorded',
  'human_recorded',
  'human',
  'studio-recording',
  'licensed-human-footage',
  'community-recorded',
  'kcisa-official-dictionary',
]);

const AI_MARKERS = ['ai', 'generated', 'synthetic', 'avatar', 'diffusion', 'model-generated'];

export interface ClipVerification {
  usable: boolean;
  problems: string[];
}

export function verifyClipMetadata(meta: KslClipMetadata | null, file: string): ClipVerification {
  const problems: string[] = [];
  if (!meta) {
    return {
      usable: false,
      problems: [
        `No metadata sidecar for ${path.basename(file)} — a clip without a sidecar is treated as unverified. ` +
          `Create ${path.basename(file).replace(/\.[^.]+$/, '.json')} (see assets/ksl/README.md).`,
      ],
    };
  }
  if (meta.verified !== true) problems.push('sidecar does not set "verified": true');

  const source = String(meta.source ?? '').toLowerCase().trim();
  if (!source) problems.push('sidecar has no "source"');
  else if (AI_MARKERS.some((m) => source.includes(m))) {
    problems.push(
      `source "${meta.source}" looks AI-generated — AI-generated signing is never publishable`,
    );
  } else if (!HUMAN_SOURCES.has(source)) {
    problems.push(
      `source "${meta.source}" is not a recognised human-recording origin (expected one of: ${[...HUMAN_SOURCES].join(', ')})`,
    );
  }

  const language = String(meta.language ?? '').toUpperCase().trim();
  if (language !== 'KSL') problems.push(`language must be "KSL", got "${meta.language ?? ''}"`);
  if (!meta.consent) problems.push('sidecar has no "consent" — publication consent must be on file');
  if (!meta.word) problems.push('sidecar has no "word"');

  return { usable: problems.length === 0, problems };
}

function sidecarFor(file: string): string {
  return file.replace(/\.[^.]+$/, '.json');
}

function readSidecar(file: string): { metadataFile: string | null; metadata: KslClipMetadata | null } {
  const sc = sidecarFor(file);
  if (!fs.existsSync(sc)) return { metadataFile: null, metadata: null };
  try {
    return { metadataFile: sc, metadata: readJson<KslClipMetadata>(sc, null as never) };
  } catch (err) {
    log.warn(`unreadable sidecar ${rel(sc)}: ${(err as Error).message}`);
    return { metadataFile: sc, metadata: null };
  }
}

/** Everything in assets/ksl, verified or not. Probing is best-effort. */
export async function loadKslLibrary(probe = false): Promise<KslClip[]> {
  if (!fs.existsSync(P.kslAssets)) return [];
  const clips: KslClip[] = [];
  for (const entry of fs.readdirSync(P.kslAssets)) {
    const full = path.join(P.kslAssets, entry);
    if (!fs.statSync(full).isFile()) continue;
    if (!VIDEO_EXT.has(path.extname(entry).toLowerCase())) continue;

    const { metadataFile, metadata } = readSidecar(full);
    const word = metadata?.word?.trim() || path.basename(entry, path.extname(entry));
    let durationSeconds: number | null = null;
    let width: number | null = null;
    let height: number | null = null;
    if (probe) {
      try {
        const probed = await ffprobeMedia(full);
        durationSeconds = probed.durationSeconds;
        width = probed.width;
        height = probed.height;
      } catch (err) {
        log.warn(`could not probe ${rel(full)}: ${(err as Error).message}`);
      }
    }
    clips.push({ word, file: full, metadataFile, metadata, durationSeconds, width, height });
  }
  return clips;
}

export function isVerified(clip: KslClip): boolean {
  return verifyClipMetadata(clip.metadata, clip.file).usable;
}
