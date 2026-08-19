import { log } from '../util/log.js';
import { rel } from '../util/paths.js';
import { lookupWord } from '../api/kcisa.js';
import { loadKslLibrary, verifyClipMetadata } from './verifier.js';
import type { KcisaSearchResult, KslClip, KslMatch } from '../types.js';

// ---------------------------------------------------------------------------
// Matching order is fixed and must not be shortcut:
//   KCISA API 검색 → 수어 명칭 확인 → local KSL library 검색 → 정확한 clip 확인
// A word that KCISA does not know never enters a script, and a word without a
// verified human clip is NEEDS_KSL_RECORDING — never AI-filled.
// ---------------------------------------------------------------------------

function normalise(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}

function findClip(clips: KslClip[], word: string): KslClip | null {
  const target = normalise(word);
  return (
    clips.find((c) => normalise(c.word) === target) ??
    clips.find((c) => normalise(c.metadata?.word ?? '') === target) ??
    null
  );
}

export interface MatchOutcome {
  matches: KslMatch[];
  /** The first hard API failure, if any: the pipeline stops on this. */
  apiFailure: KcisaSearchResult | null;
  allVerified: boolean;
  anyKcisaFail: boolean;
}

export async function matchKslWords(words: string[]): Promise<MatchOutcome> {
  const clips = await loadKslLibrary(true);
  log.info(`local KSL library: ${clips.length} clip file(s)`);

  const matches: KslMatch[] = [];
  let apiFailure: KcisaSearchResult | null = null;

  for (const word of words) {
    log.info(`— "${word}"`);
    const { result, exact } = await lookupWord(word);

    if (result.status === 'KSL_DATA_UNAVAILABLE') {
      apiFailure ??= result;
      matches.push({
        word,
        status: 'NEEDS_KSL_RECORDING',
        clip: null,
        kcisaRecord: null,
        kcisaMatch: 'FAIL',
        problems: [`KCISA lookup unavailable (${result.reason}): ${result.message}`],
      });
      continue;
    }

    const problems: string[] = [];
    if (!exact) {
      problems.push(
        `KCISA has no entry naming "${word}" (searched ${result.totalCount} record(s) via ${result.endpoint}).`,
      );
    } else {
      log.ok(`KCISA match: ${exact.title || '(untitled)'} [${exact.id}]`);
    }

    const clip = findClip(clips, word);
    if (!clip) {
      problems.push(
        `No clip for "${word}" in assets/ksl/. Record one with a real signer, or swap the script to a word that has one.`,
      );
    } else {
      const check = verifyClipMetadata(clip.metadata, clip.file);
      if (!check.usable) problems.push(...check.problems);
      else log.ok(`verified human clip: ${rel(clip.file)}`);
    }

    const verified = Boolean(exact) && Boolean(clip) && problems.length === 0;
    matches.push({
      word,
      status: verified ? 'VERIFIED' : 'NEEDS_KSL_RECORDING',
      // Keep the clip reference even when unusable: the report needs to say
      // "a file exists but is not verified", which is different from "no file".
      clip,
      kcisaRecord: exact,
      kcisaMatch: exact ? 'PASS' : 'FAIL',
      problems,
    });
    if (!verified) problems.forEach((p) => log.warn(p));
  }

  return {
    matches,
    apiFailure,
    allVerified: matches.length > 0 && matches.every((m) => m.status === 'VERIFIED'),
    anyKcisaFail: matches.some((m) => m.kcisaMatch === 'FAIL'),
  };
}

/**
 * Verified alternatives, so a blocked topic can be swapped for a shootable one
 * instead of tempting anyone into generating hands.
 */
export async function verifiedWordsAvailable(): Promise<string[]> {
  const clips = await loadKslLibrary(false);
  return clips
    .filter((c) => verifyClipMetadata(c.metadata, c.file).usable)
    .map((c) => c.word)
    .sort();
}
