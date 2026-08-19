import { P } from '../util/paths.js';
import { readJson, writeJson } from '../util/json.js';
import { content as contentConfig } from '../util/config.js';
import { log } from '../util/log.js';
import { SERIES_NAMES, type SeriesName, type TopicSeed, type TopicsFile } from '../types.js';

// ---------------------------------------------------------------------------
// Topic selection: unused first, priority next, recency as a brake, and series
// share pulled back toward the target mix (40 / 25 / 20 / 15). Metrics from
// data/performance.json nudge priority — they never override KSL accuracy or
// tone, which are decided elsewhere and are not negotiable.
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  createdAt: string;
  slug: string;
  topicId: string;
  topic: string;
  series: SeriesName;
  brollUsed: string[];
  mode: 'render' | 'preview';
  publishReady: boolean;
}

interface HistoryFile {
  _comment?: string;
  _schemaVersion?: number;
  entries: HistoryEntry[];
}

interface PerformanceEntry {
  topicId?: string;
  series?: SeriesName;
  views?: number;
  likes?: number;
  comments?: number;
  retention?: number;
  subscribers?: number;
  duration?: number;
  publishDate?: string;
}

interface PerformanceFile {
  _comment?: string;
  _schemaVersion?: number;
  entries: PerformanceEntry[];
}

export function loadTopics(): TopicsFile {
  const file = readJson<TopicsFile>(P.topics, { topics: [] });
  if (!Array.isArray(file.topics) || file.topics.length === 0) {
    throw new Error(`No topics defined in ${P.topics}`);
  }
  return file;
}

export function loadHistory(): HistoryEntry[] {
  return readJson<HistoryFile>(P.renderHistory, { entries: [] }).entries ?? [];
}

/**
 * Rotation state comes from published renders only. A preview is a
 * work-in-progress, so it must not consume a topic, burn a B-roll clip or flip
 * the structure variant — otherwise repeated preview attempts starve the
 * rotation rules. Matches markTopicUsed(), which already skips previews.
 */
export function rotationHistory(): HistoryEntry[] {
  return loadHistory().filter((e) => e.mode === 'render');
}

function loadPerformance(): PerformanceEntry[] {
  return readJson<PerformanceFile>(P.performance, { entries: [] }).entries ?? [];
}

const DAY_MS = 86_400_000;

function daysSince(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / DAY_MS;
}

/** How far each series is below its target share of recent output. */
function seriesDeficit(history: HistoryEntry[]): Record<SeriesName, number> {
  const cfg = contentConfig();
  const recent = history.slice(-20);
  const deficit = {} as Record<SeriesName, number>;
  for (const s of SERIES_NAMES) {
    const target = cfg.series[s]?.share ?? 0;
    const actual = recent.length ? recent.filter((e) => e.series === s).length / recent.length : 0;
    deficit[s] = target - actual;
  }
  return deficit;
}

/** Mean of a metric across published videos for a series, 0 when unknown. */
function performanceBias(topic: TopicSeed, perf: PerformanceEntry[]): number {
  const forSeries = perf.filter((p) => p.series === topic.series && typeof p.retention === 'number');
  if (!forSeries.length) return 0;
  const mean =
    forSeries.reduce((acc, p) => acc + (p.retention ?? 0), 0) / forSeries.length;
  // retention is a 0–1 fraction; keep the nudge small and bounded.
  return Math.max(-1, Math.min(1, (mean - 0.5) * 2)) * 0.5;
}

export interface Scored {
  topic: TopicSeed;
  score: number;
  reasons: string[];
  eligible: boolean;
  blockedBy: string | null;
}

export function scoreTopics(topics: TopicSeed[], history: HistoryEntry[]): Scored[] {
  const cfg = contentConfig();
  const deficit = seriesDeficit(history);
  const perf = loadPerformance();
  const lastSeries = history.at(-1)?.series ?? null;
  const runLength = (() => {
    if (!lastSeries) return 0;
    let n = 0;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]?.series === lastSeries) n += 1;
      else break;
    }
    return n;
  })();

  return topics.map((topic) => {
    const reasons: string[] = [];
    let blockedBy: string | null = null;

    if (topic.status === 'retired') blockedBy = 'status is retired';

    const historyForTopic = history.filter((h) => h.topicId === topic.id);
    const lastUsed = topic.lastUsedAt ?? historyForTopic.at(-1)?.createdAt ?? null;
    const age = daysSince(lastUsed);
    if (age < cfg.rotation.minDaysBeforeTopicRepeat) {
      blockedBy = `used ${age.toFixed(1)} day(s) ago (min gap ${cfg.rotation.minDaysBeforeTopicRepeat}d)`;
    }
    if (
      !blockedBy &&
      lastSeries === topic.series &&
      runLength >= cfg.rotation.maxSameSeriesInARow
    ) {
      blockedBy = `${topic.series} already ran ${runLength}× in a row (max ${cfg.rotation.maxSameSeriesInARow})`;
    }

    let score = topic.priority;
    reasons.push(`priority ${topic.priority}`);

    if (topic.status === 'unused') {
      score += 2;
      reasons.push('never used (+2)');
    }
    const d = deficit[topic.series] ?? 0;
    const seriesPoints = d * 6;
    score += seriesPoints;
    reasons.push(`${topic.series} share ${d >= 0 ? 'under' : 'over'} target (${seriesPoints >= 0 ? '+' : ''}${seriesPoints.toFixed(2)})`);

    if (Number.isFinite(age)) {
      const stalePoints = Math.min(2, age / 60);
      score += stalePoints;
      reasons.push(`last used ${age.toFixed(0)}d ago (+${stalePoints.toFixed(2)})`);
    }

    const bias = performanceBias(topic, perf);
    if (bias !== 0) {
      score += bias;
      reasons.push(`series retention bias (${bias >= 0 ? '+' : ''}${bias.toFixed(2)})`);
    }

    if (topic.kslWords.length === 0) {
      blockedBy ??= 'no kslWords declared — nothing to verify against KCISA';
    }

    return { topic, score, reasons, eligible: !blockedBy, blockedBy };
  });
}

export interface SelectOptions {
  requestedTopic?: string;
  requestedSeries?: SeriesName;
  random?: boolean;
  /** Allow picking a topic the rotation rules would normally block. */
  force?: boolean;
}

export function selectTopic(opts: SelectOptions = {}): TopicSeed {
  const { topics } = loadTopics();
  const history = rotationHistory();

  if (opts.requestedTopic) {
    const needle = opts.requestedTopic.replace(/\s+/g, '').toLowerCase();
    const hit = topics.find(
      (t) =>
        t.id.toLowerCase() === opts.requestedTopic!.toLowerCase() ||
        t.topic.replace(/\s+/g, '').toLowerCase() === needle ||
        t.kslWords.some((w) => w.replace(/\s+/g, '').toLowerCase() === needle),
    );
    if (!hit) {
      const known = topics.map((t) => t.topic).join(', ');
      throw new Error(
        `No topic seed matches "${opts.requestedTopic}".\n` +
          `Add it to data/topics.json (with its kslWords), or pick one of: ${known}`,
      );
    }
    log.ok(`topic requested explicitly: ${hit.topic} [${hit.series}]`);
    return hit;
  }

  let pool = scoreTopics(topics, history).filter(
    (s) => !opts.requestedSeries || s.topic.series === opts.requestedSeries,
  );
  if (pool.length === 0) throw new Error(`No topics for series ${opts.requestedSeries}`);

  const eligible = pool.filter((s) => s.eligible);
  if (eligible.length === 0) {
    if (!opts.force) {
      const why = pool
        .slice(0, 5)
        .map((s) => `  · ${s.topic.topic}: ${s.blockedBy}`)
        .join('\n');
      throw new Error(
        `Every topic is currently blocked by rotation rules:\n${why}\n` +
          'Add new topics to data/topics.json, or re-run with --force.',
      );
    }
    log.warn('rotation rules overridden by --force');
  } else {
    pool = eligible;
  }

  pool.sort((a, b) => b.score - a.score);

  let chosen = pool[0]!;
  if (opts.random) {
    // Weighted pick over the strongest few, so "random" still respects priority.
    const top = pool.slice(0, Math.min(5, pool.length));
    const total = top.reduce((acc, s) => acc + Math.max(0.1, s.score), 0);
    let roll = Math.random() * total;
    for (const cand of top) {
      roll -= Math.max(0.1, cand.score);
      if (roll <= 0) {
        chosen = cand;
        break;
      }
    }
  }

  log.ok(`topic: ${chosen.topic.topic} [${chosen.topic.series}] score ${chosen.score.toFixed(2)}`);
  log.debug(`why: ${chosen.reasons.join('; ')}`);
  const runnersUp = pool.slice(1, 4).map((s) => `${s.topic.topic} (${s.score.toFixed(1)})`);
  if (runnersUp.length) log.debug(`runners-up: ${runnersUp.join(', ')}`);
  return chosen.topic;
}

/** Persist that a topic was used. Called only after a render actually happened. */
export function markTopicUsed(topicId: string, mode: 'render' | 'preview'): void {
  // A preview is a work-in-progress, not a published video: it must not consume
  // the topic or the rotation rules would starve on failed attempts.
  if (mode === 'preview') return;
  const file = loadTopics();
  const topic = file.topics.find((t) => t.id === topicId);
  if (!topic) return;
  topic.status = 'used';
  topic.lastUsedAt = new Date().toISOString();
  topic.usedCount = (topic.usedCount ?? 0) + 1;
  writeJson(P.topics, file);
}

export function appendHistory(entry: HistoryEntry): void {
  const file = readJson<HistoryFile>(P.renderHistory, { entries: [] });
  file._schemaVersion ??= 1;
  file.entries = [...(file.entries ?? []), entry].slice(-500);
  writeJson(P.renderHistory, file);
}

/** B-roll files used by the last N videos, which must not be reused. */
export function recentlyUsedBroll(): Set<string> {
  const cfg = contentConfig();
  const history = rotationHistory();
  const recent = history.slice(-cfg.rotation.brollNoRepeatWindow);
  return new Set(recent.flatMap((e) => e.brollUsed ?? []));
}
