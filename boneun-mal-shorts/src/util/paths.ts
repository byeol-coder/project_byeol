import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Project root = the directory containing package.json (…/boneun-mal-shorts). */
export const ROOT = path.resolve(here, '..', '..');

export const P = {
  root: ROOT,
  config: path.join(ROOT, 'config'),
  data: path.join(ROOT, 'data'),
  assets: path.join(ROOT, 'assets'),
  kslAssets: path.join(ROOT, 'assets', 'ksl'),
  brollAssets: path.join(ROOT, 'assets', 'broll'),
  musicAssets: path.join(ROOT, 'assets', 'music'),
  sfxAssets: path.join(ROOT, 'assets', 'sfx'),
  logoAssets: path.join(ROOT, 'assets', 'logos'),
  imageAssets: path.join(ROOT, 'assets', 'images'),
  output: path.join(ROOT, 'output'),
  cache: path.join(ROOT, '.cache'),
  rawApiLog: path.join(ROOT, '.cache', 'kcisa-raw'),
  topics: path.join(ROOT, 'data', 'topics.json'),
  signGlosses: path.join(ROOT, 'data', 'sign-glosses.json'),
  kslCache: path.join(ROOT, 'data', 'ksl-cache.json'),
  performance: path.join(ROOT, 'data', 'performance.json'),
  renderHistory: path.join(ROOT, 'data', 'render-history.json'),
} as const;

/** Path relative to the project root, for readable logs. */
export function rel(p: string): string {
  return path.relative(ROOT, p) || '.';
}
