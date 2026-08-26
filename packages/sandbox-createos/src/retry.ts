/**
 * Bounded retry wrapper for CreateOS API calls. Mirrors the Daytona/E2B
 * provider helpers: lifecycle reads and idempotent operations can ride through
 * transient 429/5xx/network failures, while non-idempotent provision opts out
 * so a timeout cannot create a duplicate billable sandbox.
 */

import { CreateOsApiError } from './client.js';

export interface WithRetryOptions {
  method: string;
  attemptTimeoutMs?: number;
  backoffMs?: readonly number[];
  retryOnAmbiguous: boolean;
  onRetry?: (line: string) => void;
}

const DEFAULT_BACKOFF: readonly number[] = [1000, 2000, 4000];
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

class AttemptTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`createos ${method}: per-attempt timeout after ${String(ms)}ms`);
    this.name = 'AttemptTimeoutError';
  }
}

export function isAttemptTimeout(err: unknown): err is AttemptTimeoutError {
  return err instanceof AttemptTimeoutError;
}

export function isRetriable(err: unknown, allowAmbiguous: boolean): boolean {
  if (err instanceof AttemptTimeoutError) return allowAmbiguous;
  if (err instanceof CreateOsApiError) {
    if (err.statusCode === 429) return true;
    if (err.statusCode >= 500 && err.statusCode <= 599) return allowAmbiguous;
    return false;
  }
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

export async function withCreateOsRetry<T>(
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
        `createos ${opts.method}: attempt ${String(attempt)} failed (${errorSummary(err)}); retrying in ${String(delay)}ms`,
      );
      await sleep(delay);
    }
  }
  throw new Error(`withCreateOsRetry: exhausted attempts for ${opts.method}`);
}

function defaultRetryLog(line: string): void {
  process.stderr.write(`\n[createos-retry] ${line}\n`);
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
  if (err instanceof CreateOsApiError) {
    return `CreateOsApiError(${String(err.statusCode)}): ${truncate(err.body)}`;
  }
  if (err instanceof Error) return `${err.name}: ${truncate(err.message)}`;
  return truncate(String(err));
}

function truncate(s: string, max = 160): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
