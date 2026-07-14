/**
 * Bounded retry wrapper for `daytonaBackend` SDK calls. Daytona's CloudFront
 * edge intermittently 504s on `executeCommand` and other API calls (backlog
 * item 6.1) — without bounded retries an edge hiccup propagates as an
 * unbounded wedge in the calling code. This helper classifies transient
 * failures vs. permanent ones using the SDK's typed error classes, bounds
 * each attempt with a timeout, and caps the total wall-clock cost.
 *
 * Non-idempotent ops (`provision`) pass `retryOnAmbiguous: false` so a 504
 * after the request reached the origin doesn't create a duplicate sandbox.
 */

import {
  DaytonaAuthenticationError,
  DaytonaAuthorizationError,
  DaytonaConflictError,
  DaytonaConnectionError,
  DaytonaError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaTimeoutError,
  DaytonaValidationError,
} from '@daytona/sdk';

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
   * responses (since 504 from CloudFront can mean "origin still processing").
   * Set false for non-idempotent operations (e.g. `provision`) where a
   * retry could create a duplicate.
   */
  retryOnAmbiguous: boolean;
  /** Override the default `process.stderr` retry sink (used by tests). */
  onRetry?: (line: string) => void;
}

const DEFAULT_BACKOFF: readonly number[] = [1000, 2000, 4000];
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

/** Internal sentinel used by the per-attempt timeout race. */
class AttemptTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`daytona ${method}: per-attempt timeout after ${String(ms)}ms`);
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
  // Rate-limit responses always carry an intent from the server: back off.
  if (err instanceof DaytonaRateLimitError) return true;

  // Permanent client-side failures: never retry — the next call will get
  // the same answer and we'd just be wasting wall-clock.
  if (
    err instanceof DaytonaNotFoundError ||
    err instanceof DaytonaAuthenticationError ||
    err instanceof DaytonaAuthorizationError ||
    err instanceof DaytonaValidationError ||
    err instanceof DaytonaConflictError
  ) {
    return false;
  }

  // Connection / per-attempt timeout: the request may not have reached
  // the server. Gated by allowAmbiguous so non-idempotent callers can opt
  // out of double-execute risk.
  if (
    err instanceof DaytonaConnectionError ||
    err instanceof DaytonaTimeoutError ||
    err instanceof AttemptTimeoutError
  ) {
    return allowAmbiguous;
  }

  // Base DaytonaError: branch on statusCode. 5xx is ambiguous; 4xx we
  // didn't catch above is a permanent failure we hadn't seen before.
  if (err instanceof DaytonaError) {
    const status = err.statusCode;
    if (typeof status === 'number' && status >= 500 && status <= 599) {
      return allowAmbiguous;
    }
    return false;
  }

  // Axios-style fallback for raw errors that leak through without an SDK
  // wrapper. Match the same shape the SDK uses internally.
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNABORTED' ||
      code === 'EAI_AGAIN' ||
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND'
    ) {
      return allowAmbiguous;
    }
    const status =
      (err as { response?: { status?: unknown } }).response?.status ??
      (err as { status?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 500 && status <= 599) {
      return allowAmbiguous;
    }
  }

  return false;
}

/**
 * Run `fn`, retrying on transient failures with capped exponential backoff.
 * Each attempt is bounded by `attemptTimeoutMs` via Promise.race; total
 * wall-clock = sum(backoffMs) + maxAttempts * attemptTimeoutMs.
 */
export async function withDaytonaRetry<T>(
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
        `daytona ${opts.method}: attempt ${String(attempt)} failed (${errorSummary(err)}); retrying in ${String(delay)}ms`,
      );
      await sleep(delay);
    }
  }
  // Unreachable: the loop above either returns or throws.
  throw new Error(`withDaytonaRetry: exhausted attempts for ${opts.method}`);
}

function defaultRetryLog(line: string): void {
  // Prefix so log scrapers + users can distinguish retry chatter from real
  // CLI output. `\n` before is intentional — many CLI surfaces use clack
  // spinners on stdout, and stderr lines without a leading newline can
  // collide with a redraw.
  process.stderr.write(`\n[daytona-retry] ${line}\n`);
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
  if (err instanceof DaytonaError) {
    const status = err.statusCode;
    const cls = err.constructor.name;
    return `${cls}${typeof status === 'number' ? ` ${String(status)}` : ''}: ${truncate(err.message)}`;
  }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return code !== undefined ? `${err.name}(${String(code)}): ${truncate(err.message)}` : `${err.name}: ${truncate(err.message)}`;
  }
  return truncate(String(err));
}

function truncate(s: string, max = 160): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
