import { log } from './log.js';

export interface HttpResult {
  ok: boolean;
  status: number;
  contentType: string;
  body: string;
  /** Non-null when the request never produced an HTTP response at all. */
  transportError: string | null;
  attempts: number;
  url: string;
}

export interface HttpOptions {
  timeoutMs: number;
  maxRetries: number;
  /** Status codes worth retrying; everything else is returned as-is. */
  retryStatuses?: number[];
}

const DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET with a hard timeout and bounded exponential backoff.
 * Returns a result object rather than throwing: callers decide what a failure
 * means, and for KSL data a failure must never silently become a fallback.
 */
export async function getWithRetry(url: string, opts: HttpOptions): Promise<HttpResult> {
  const retryStatuses = opts.retryStatuses ?? DEFAULT_RETRY_STATUSES;
  let attempts = 0;
  let last: HttpResult = {
    ok: false,
    status: 0,
    contentType: '',
    body: '',
    transportError: 'not attempted',
    attempts: 0,
    url,
  };

  while (attempts < Math.max(1, opts.maxRetries)) {
    attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json, text/xml;q=0.9, */*;q=0.5' },
        redirect: 'follow',
      });
      const body = await res.text();
      last = {
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body,
        transportError: null,
        attempts,
        url,
      };
      if (res.ok || !retryStatuses.includes(res.status)) return last;
      log.warn(`HTTP ${res.status} (attempt ${attempts}/${opts.maxRetries})`);
    } catch (err) {
      const e = err as Error;
      const reason = e.name === 'AbortError' ? `timeout after ${opts.timeoutMs}ms` : e.message;
      last = {
        ok: false,
        status: 0,
        contentType: '',
        body: '',
        transportError: reason,
        attempts,
        url,
      };
      log.warn(`request failed: ${reason} (attempt ${attempts}/${opts.maxRetries})`);
    } finally {
      clearTimeout(timer);
    }
    if (attempts < opts.maxRetries) await sleep(2 ** (attempts - 1) * 1000);
  }
  return last;
}
