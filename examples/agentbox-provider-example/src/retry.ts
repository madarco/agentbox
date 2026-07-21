/**
 * Bounded retry wrapper for Vercel Sandbox SDK calls — mirrors
 * `withDaytonaRetry` / `withHetznerRetry` in shape and intent. The Vercel
 * control plane rate-limits (429) and can return transient 5xx during
 * incidents; without bounded retries those propagate as wedges in the calling
 * lifecycle code.
 *
 * Non-idempotent ops (`provision`/`Sandbox.create`, `createSnapshot`) pass
 * `retryOnAmbiguous: false` so a timeout after the request reached the origin
 * doesn't create a duplicate billable sandbox/snapshot.
 */

export interface WithRetryOptions {
  method: string;
  /** Per-attempt timeout (ms). Default 30_000. */
  attemptTimeoutMs?: number;
  /** Backoff before attempts 2, 3, … (ms). Default [1000, 2000, 4000]. */
  backoffMs?: readonly number[];
  /**
   * Retry on errors where we can't be sure the server applied the request
   * (connection failures, per-attempt timeouts, 5xx). Set false for
   * non-idempotent operations where a retry could create a duplicate resource.
   */
  retryOnAmbiguous: boolean;
  /** Override the default stderr retry sink (used by tests). */
  onRetry?: (line: string) => void;
}

const DEFAULT_BACKOFF: readonly number[] = [1000, 2000, 4000];
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

class AttemptTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`vercel ${method}: per-attempt timeout after ${String(ms)}ms`);
    this.name = 'AttemptTimeoutError';
  }
}

export function isAttemptTimeout(err: unknown): err is AttemptTimeoutError {
  return err instanceof AttemptTimeoutError;
}

/** HTTP status code dug out of whatever error shape the SDK throws. */
function statusCodeOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  for (const key of ['statusCode', 'status', 'code'] as const) {
    const v = (err as Record<string, unknown>)[key];
    if (typeof v === 'number') return v;
  }
  const resp = (err as { response?: { status?: unknown } }).response;
  if (resp && typeof resp.status === 'number') return resp.status;
  return undefined;
}

export function isRetriable(err: unknown, allowAmbiguous: boolean): boolean {
  if (err instanceof AttemptTimeoutError) return allowAmbiguous;

  const status = statusCodeOf(err);
  if (status !== undefined) {
    if (status === 429) return true; // rate limited — the server told us to wait
    if (status >= 500 && status <= 599) return allowAmbiguous;
    return false; // 4xx (auth, validation, not_found) — permanent
  }

  // Raw fetch / undici errors. Node wraps low-level errors in `{ cause }`.
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

export async function withVercelRetry<T>(
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
        `vercel ${opts.method}: attempt ${String(attempt)} failed (${errorSummary(err)}); retrying in ${String(delay)}ms`,
      );
      await sleep(delay);
    }
  }
  throw new Error(`withVercelRetry: exhausted attempts for ${opts.method}`);
}

function defaultRetryLog(line: string): void {
  process.stderr.write(`\n[vercel-retry] ${line}\n`);
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
    const status = statusCodeOf(err);
    return status !== undefined
      ? `${err.name}(${String(status)}): ${truncate(err.message)}`
      : `${err.name}: ${truncate(err.message)}`;
  }
  return truncate(String(err));
}

function truncate(s: string, max = 160): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
