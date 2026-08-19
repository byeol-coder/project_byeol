import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';

/**
 * Minimal .env loader. Deliberately dependency-free and deliberately
 * non-overriding: a value already in process.env wins, so CI secrets beat a
 * stale local file. Secrets are only ever read from here — never from source.
 */
let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const file of ['.env', '.env.local']) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    for (const rawLine of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!key || key in process.env) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

export function env(key: string, fallback = ''): string {
  loadEnv();
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

export function envInt(key: string, fallback: number): number {
  const raw = env(key);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function requireEnv(key: string): string | null {
  const v = env(key);
  return v ? v : null;
}

/** Never print a secret. Enough to confirm which key is loaded, no more. */
export function maskSecret(value: string): string {
  if (!value) return '(empty)';
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}…${value.slice(-2)} (len ${value.length})`;
}
