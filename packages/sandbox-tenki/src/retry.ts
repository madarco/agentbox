/**
 * Bounded retry wrapper for Tenki SDK calls — mirrors `withE2bRetry` /
 * `withVercelRetry` in shape and intent. The Tenki API rate-limits and can
 * report transient capacity / transport errors during incidents; without
 * bounded retries those propagate as wedges in the calling lifecycle code.
 *
 * Non-idempotent ops (`provision`/`createAndWait`) pass `retryOnAmbiguous:
 * false` so a timeout after the request reached the origin doesn't create a
 * duplicate billable session.
 *
 * Classification is by the SDK's typed error names (`RateLimitedError`,
 * `CapacityUnavailableError`, …) plus ConnectRPC status codes (the SDK is
 * ConnectRPC-based) and raw Node socket error codes.
 */

export interface WithRetryOptions {
  method: string;
  /** Per-attempt timeout (ms). Default 30_000. */
  attemptTimeoutMs?: number;
  /** Backoff before attempts 2, 3, … (ms). Default [1000, 2000, 4000]. */
  backoffMs?: readonly number[];
  /**
   * Retry on errors where we can't be sure the server applied the request
   * (connection failures, per-attempt timeouts, transient transport). Set
   * false for non-idempotent operations where a retry could create a duplicate
   * resource.
   */
  retryOnAmbiguous: boolean;
  /** Override the default stderr retry sink (used by tests). */
  onRetry?: (line: string) => void;
}

const DEFAULT_BACKOFF: readonly number[] = [1000, 2000, 4000];
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

class AttemptTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`tenki ${method}: per-attempt timeout after ${String(ms)}ms`);
    this.name = 'AttemptTimeoutError';
  }
}

export function isAttemptTimeout(err: unknown): err is AttemptTimeoutError {
  return err instanceof AttemptTimeoutError;
}

/** ConnectRPC status code string (e.g. "unavailable") dug out of the error. */
function connectCodeOf(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Numeric HTTP status code dug out of whatever error shape the SDK throws. */
function statusCodeOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  for (const key of ['statusCode', 'status'] as const) {
    const v = (err as Record<string, unknown>)[key];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/** ConnectRPC codes that are safe-to-retry transient server conditions. */
const RETRIABLE_CONNECT_CODES = new Set([
  'unavailable',
  'resource_exhausted',
  'deadline_exceeded',
  'aborted',
]);

export function isRetriable(err: unknown, allowAmbiguous: boolean): boolean {
  if (err instanceof AttemptTimeoutError) return allowAmbiguous;

  // Match the SDK's typed errors by name to avoid an import cycle
  // (sdk.ts → retry → sdk). RateLimited / CapacityUnavailable are explicitly
  // transient; auth / not-found / quota / invalid-state are terminal.
  const name = err instanceof Error ? err.name : undefined;
  if (name === 'RateLimitedError' || name === 'CapacityUnavailableError') return true;
  if (
    name === 'UnauthorizedError' ||
    name === 'PermissionDeniedError' ||
    name === 'MissingAuthTokenError' ||
    name === 'SessionNotFoundError' ||
    name === 'SnapshotNotFoundError' ||
    name === 'QuotaExceededError' ||
    name === 'InvalidStateError' ||
    name === 'FileNotFoundError'
  ) {
    return false;
  }

  // Only short-circuit on a KNOWN retriable Connect code. A non-retriable
  // Connect code (e.g. `permission_denied`) and raw Node socket codes (e.g.
  // `ECONNRESET`) both fall through to the status / socket checks below — so a
  // socket error isn't misread as a terminal Connect code and dropped.
  const connectCode = connectCodeOf(err);
  if (connectCode !== undefined && RETRIABLE_CONNECT_CODES.has(connectCode)) {
    // `aborted` / `deadline_exceeded` are ambiguous (the server may have
    // applied the call); `unavailable` / `resource_exhausted` are pre-apply.
    return connectCode === 'unavailable' || connectCode === 'resource_exhausted'
      ? true
      : allowAmbiguous;
  }

  const status = statusCodeOf(err);
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return allowAmbiguous;
    return false;
  }

  // Raw fetch / undici / ws errors. Node wraps low-level errors in `{ cause }`.
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
        code === 'EPIPE' ||
        code === 'UND_ERR_SOCKET' ||
        code === 'UND_ERR_CONNECT_TIMEOUT'
      ) {
        return allowAmbiguous;
      }
    }
  }
  return false;
}

export async function withTenkiRetry<T>(opts: WithRetryOptions, fn: () => Promise<T>): Promise<T> {
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
        `tenki ${opts.method}: attempt ${String(attempt)} failed (${errorSummary(err)}); retrying in ${String(delay)}ms`,
      );
      await sleep(delay);
    }
  }
  throw new Error(`withTenkiRetry: exhausted attempts for ${opts.method}`);
}

function defaultRetryLog(line: string): void {
  process.stderr.write(`\n[tenki-retry] ${line}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  if (err instanceof Error) {
    const code = connectCodeOf(err) ?? statusCodeOf(err);
    return code !== undefined
      ? `${err.name}(${String(code)}): ${truncate(err.message)}`
      : `${err.name}: ${truncate(err.message)}`;
  }
  return truncate(String(err));
}

function truncate(s: string, max = 160): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
