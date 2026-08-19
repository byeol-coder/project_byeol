import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

// ---------------------------------------------------------------------------
// Binary file download with a timeout and bounded retries. Used only for
// pulling officially-licensed clips (npm run ksl:import) — never for anything
// that pretends to be sign language it isn't.
// ---------------------------------------------------------------------------

export interface DownloadOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

export interface DownloadResult {
  ok: boolean;
  status: number;
  bytes: number;
  contentType: string;
  error: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Atomic: writes to a temp file and renames, so a failed download never leaves a partial file. */
export async function downloadFile(
  url: string,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxRetries = Math.max(1, opts.maxRetries ?? 3);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  let lastError = 'not attempted';
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        log.warn(`download failed: ${lastError} (attempt ${attempt}/${maxRetries})`);
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        const tmp = `${destPath}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, destPath);
        return {
          ok: true,
          status: res.status,
          bytes: buf.length,
          contentType: res.headers.get('content-type') ?? '',
          error: null,
        };
      }
    } catch (err) {
      const e = err as Error;
      lastError = e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message;
      log.warn(`download failed: ${lastError} (attempt ${attempt}/${maxRetries})`);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxRetries) await sleep(2 ** (attempt - 1) * 1000);
  }
  return { ok: false, status: 0, bytes: 0, contentType: '', error: lastError };
}
