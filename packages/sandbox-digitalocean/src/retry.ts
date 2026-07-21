/**
 * Bounded retry wrapper for DigitalOcean Cloud API calls — mirrors
 * `withDaytonaRetry` in shape and intent. DigitalOcean is generally well-behaved
 * but the public API does rate-limit (429) and occasionally returns 502/504
 * during regional incidents; without bounded retries those propagate as
 * wedges in the calling lifecycle code.
 *
 * Non-idempotent ops (`provision`, `createImage`) pass
 * `retryOnAmbiguous: false` so a 504 after the request reached the origin
 * doesn't create a duplicate billable resource.
 */

import { DigitalOceanApiError } from './client.js';

export interface WithRetryOptions {
  /** Method name, used in retry log lines. */
  method: string;
  /** Per-attempt timeout (ms). Default 30_000. */
  attemptTimeoutMs?: number;
  /** Backoff before attempts 2, 3, … (ms). Default [1000, 2000, 4000]. */
  backoffMs?: readonly number[];
  /**
   * Whether to retry on errors where we can't be sure the server applied
   * the request — connection failures, per-attempt timeouts, and 5xx
   * responses. Set false for non-idempotent operations (e.g. `provision`,
   * `createImage`) where a retry could create a duplicate resource.
   */
  retryOnAmbiguous: boolean;
  /** Override the default `process.stderr` retry sink (used by tests). */
  onRetry?: (line: string) => void;
}

const DEFAULT_BACKOFF: readonly number[] = [1000, 2000, 4000];
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

class AttemptTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`digitalocean ${method}: per-attempt timeout after ${String(ms)}ms`);
    this.name = 'AttemptTimeoutError';
  }
}

export function isAttemptTimeout(err: unknown): err is AttemptTimeoutError {
  return err instanceof AttemptTimeoutError;
}

/**
 * Classify an error as retriable or not. `allowAmbiguous` gates the cases
 * where the server may or may not have applied the request — the caller
 * decides based on idempotency.
 */
export function isRetriable(err: unknown, allowAmbiguous: boolean): boolean {
  if (err instanceof DigitalOceanApiError) {
    // Rate limit: always back off — the server told us to.
    if (err.statusCode === 429 || err.code === 'rate_limit_exceeded') return true;
    // 5xx: ambiguous (the API may or may not have applied the change).
    if (err.statusCode >= 500 && err.statusCode <= 599) return allowAmbiguous;
    // DigitalOcean conflict / locked errors: the API tells us to wait — same as
    // rate-limit semantically. `conflict` is what `delete_server` returns
    // when another action (e.g. our own poweroff) is still in flight.
    if (err.code === 'locked' || err.code === 'conflict') return true;
    // Everything else is a permanent client error (auth, validation, not_found).
    return false;
  }

  if (err instanceof AttemptTimeoutError) return allowAmbiguous;

  // Raw fetch / undici errors. The Node fetch impl wraps low-level errors in
  // `{ cause }`; we check both shapes for portability.
  if (err && typeof err === 'object') {
    const candidates: unknown[] = [err, (err as { cause?: unknown }).cause];
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      const code = (c as { code?: unknown }).code;
      if (
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNABORTED' ||
        code === 'EAI_AGAIN' ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'UND_ERR_SOCKET' ||
        code === 'UND_ERR_CONNECT_TIMEOUT'
      ) {
        return allowAmbiguous;
      }
    }
  }

  return false;
}

/**
 * Run `fn`, retrying on transient failures with capped exponential backoff.
 * Each attempt is bounded by `attemptTimeoutMs` via Promise.race; total
 * wall-clock = sum(backoffMs) + maxAttempts * attemptTimeoutMs.
 */
export async function withDigitalOceanRetry<T>(
  opts: WithRetryOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  const maxAttempts = backoff.length + 1;
  const timeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const log = opts.onRetry ?? defaultRetryLog;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await raceTimeout(fn(), timeoutMs, opts.method);
    } catch (err) {
      const last = attempt === maxAttempts;
      if (last || !isRetriable(err, opts.retryOnAmbiguous)) throw err;
      const delay = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 4000;
      log(
        `digitalocean ${opts.method}: attempt ${String(attempt)} failed (${errorSummary(err)}); retrying in ${String(delay)}ms`,
      );
      await sleep(delay);
    }
  }
  throw new Error(`withDigitalOceanRetry: exhausted attempts for ${opts.method}`);
}

function defaultRetryLog(line: string): void {
  process.stderr.write(`\n[digitalocean-retry] ${line}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceTimeout<T>(p: Promise<T>, ms: number, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AttemptTimeoutError(method, ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorSummary(err: unknown): string {
  if (err instanceof DigitalOceanApiError) {
    return `DigitalOceanApiError ${String(err.statusCode)} ${err.code}: ${truncate(err.message)}`;
  }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return code !== undefined
      ? `${err.name}(${String(code)}): ${truncate(err.message)}`
      : `${err.name}: ${truncate(err.message)}`;
  }
  return truncate(String(err));
}

function truncate(s: string, max = 160): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
