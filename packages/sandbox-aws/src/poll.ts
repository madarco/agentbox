/**
 * Polling helpers — wait for a AWS EC2 resource to reach a desired
 * state. Reused across the prepare flow + Phase 4 backend lifecycle.
 *
 * Bounded by `deadlineMs`; intervals grow modestly (1s → 2s → 4s, capped)
 * so a fast-completing action is observed quickly without hammering the
 * API for slow ones.
 */

export interface PollOptions {
  deadlineMs?: number;
  /** Starting interval; doubles per attempt up to `maxIntervalMs`. */
  intervalMs?: number;
  maxIntervalMs?: number;
  /** Optional logger for each poll attempt — useful to stream progress. */
  onPoll?: (line: string) => void;
}

/**
 * Poll `check()` until it returns a non-null value or `deadlineMs` elapses.
 * Throws on timeout with the supplied `label` in the message.
 */
export async function pollUntil<T>(
  label: string,
  check: () => Promise<T | null | undefined>,
  opts: PollOptions = {},
): Promise<T> {
  const deadline = Date.now() + (opts.deadlineMs ?? 5 * 60_000);
  const max = opts.maxIntervalMs ?? 10_000;
  let interval = opts.intervalMs ?? 1_000;
  let attempt = 0;
  while (true) {
    attempt += 1;
    const out = await check();
    if (out !== null && out !== undefined) return out;
    if (Date.now() >= deadline) {
      throw new Error(`aws: timed out waiting for ${label} after ${String(attempt)} attempts`);
    }
    opts.onPoll?.(`${label}: not ready yet (attempt ${String(attempt)}); polling again in ${String(interval)}ms`);
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval * 2, max);
  }
}
