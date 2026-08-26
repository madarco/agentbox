import type { Store } from './store/store.js';

/**
 * Periodic housekeeping for a resident control box: sweep answered prompts and
 * finished create jobs so the durable tables don't grow without bound. Events
 * are already ring-trimmed on append; prompts + jobs are not.
 *
 * A no-op unless the store implements the prune methods (durable stores only —
 * the laptop's MemoryStore is process-lifetime, nothing to sweep). Modeled on
 * the other daemon loops (timer, `unref`, never crashes the process).
 */

/** Rows are kept this long after they finish before a sweep removes them. */
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_INTERVAL_MS = 60 * 60_000;

export interface RetentionLoopDeps {
  store: Store;
  log: (line: string) => void;
  /** How long a finished row survives before it's swept. Default 24h. */
  retentionMs?: number;
  /** Sweep cadence. Default hourly. */
  intervalMs?: number;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface RetentionLoopHandle {
  stop: () => Promise<void>;
}

export function startRetentionLoop(deps: RetentionLoopDeps): RetentionLoopHandle {
  const { store, log } = deps;
  const retentionMs = deps.retentionMs ?? DEFAULT_RETENTION_MS;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const nowFn = deps.now ?? Date.now;

  // Nothing to sweep on a store without the prune methods (localhost/tests).
  if (!store.prunePrompts && !store.pruneCreateJobs) {
    return { stop: () => Promise.resolve() };
  }

  let ticking = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const before = new Date(nowFn() - retentionMs).toISOString();
      const prompts = (await store.prunePrompts?.(before)) ?? 0;
      const jobs = (await store.pruneCreateJobs?.(before)) ?? 0;
      if (prompts > 0 || jobs > 0) {
        log(`retention: pruned ${String(prompts)} prompt(s), ${String(jobs)} create job(s)`);
      }
    } catch (err) {
      log(`retention: tick error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = tick();
  }, intervalMs);
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight.catch(() => {});
    },
  };
}
