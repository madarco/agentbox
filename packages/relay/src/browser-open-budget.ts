/**
 * Rate limiter for mirroring an in-box `browser.open` on the host browser.
 *
 * Opening a link on the host is part of the safe host-action subset
 * (`box.autoApproveSafeHostActions`), so it no longer waits for a human. The
 * confirm prompt used to double as the rate limiter — without it a looping
 * agent could spray the host with tabs — so the budget below takes over that
 * job: two opens per 30s and ten per 10 minutes, per box, counting every URL.
 *
 * Shared by the docker (`server.ts`) and cloud (`host-actions.ts`) mirror
 * paths, for the same reason `safe-transfer.ts` is shared: the policy must not
 * drift between the two transports.
 */

/** Burst window: at most 2 host opens per box per 30s. */
export const BROWSER_OPEN_BURST = { limit: 2, windowMs: 30_000 } as const;
/** Sustained window: at most 10 host opens per box per 10 minutes. */
export const BROWSER_OPEN_SUSTAINED = { limit: 10, windowMs: 600_000 } as const;
/** A repeat of the exact same URL inside this window is dropped, not re-opened. */
export const BROWSER_OPEN_DEDUPE_MS = 30_000;

export type BrowserOpenDecision =
  /** Auto-approve: audit it and open on the host, no human involved. */
  | { action: 'open'; reason: string }
  /** Ask the host user, exactly as before the safe-subset change. */
  | { action: 'prompt'; reason: string }
  /** Duplicate link — do nothing at all (no open, no prompt). */
  | { action: 'drop'; reason: string };

interface OpenRecord {
  url: string;
  at: number;
}

/**
 * Per-box sliding-window budget. Stateful but pure of I/O; the clock is
 * injectable so the windows are unit-testable without waiting on real time.
 */
export class BrowserOpenBudget {
  private readonly opens = new Map<string, OpenRecord[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Decide what to do with a host-mirror request. Reads only — the caller
   * calls {@link record} when a host open actually happens, so a link the user
   * approved at the prompt feeds the same windows as an auto-approved one.
   */
  decide(boxId: string, url: string, autoApproveSafe: boolean): BrowserOpenDecision {
    const recent = this.prune(boxId);
    const now = this.now();
    if (recent.some((r) => r.url === url && now - r.at < BROWSER_OPEN_DEDUPE_MS)) {
      // A retry loop re-opening the identical tab is noise: it must not consume
      // budget, and it must not fall back to a prompt either.
      return { action: 'drop', reason: 'duplicate url' };
    }
    if (!autoApproveSafe) {
      return { action: 'prompt', reason: 'box.autoApproveSafeHostActions is false' };
    }
    const inWindow = (windowMs: number): number =>
      recent.reduce((n, r) => (now - r.at < windowMs ? n + 1 : n), 0);
    if (inWindow(BROWSER_OPEN_BURST.windowMs) >= BROWSER_OPEN_BURST.limit) {
      return { action: 'prompt', reason: 'burst limit' };
    }
    if (inWindow(BROWSER_OPEN_SUSTAINED.windowMs) >= BROWSER_OPEN_SUSTAINED.limit) {
      return { action: 'prompt', reason: 'sustained limit' };
    }
    return { action: 'open', reason: 'safe: browser.open' };
  }

  /** Charge one host open against the box's windows. */
  record(boxId: string, url: string): void {
    const recent = this.prune(boxId);
    recent.push({ url, at: this.now() });
    this.opens.set(boxId, recent);
  }

  /** Forget a box entirely (destroy / unregister). */
  forget(boxId: string): void {
    this.opens.delete(boxId);
  }

  /**
   * Drop stamps older than the widest window, so a box that opened a few links
   * and went away leaves no entry behind.
   */
  private prune(boxId: string): OpenRecord[] {
    const now = this.now();
    const kept = (this.opens.get(boxId) ?? []).filter(
      (r) => now - r.at < BROWSER_OPEN_SUSTAINED.windowMs,
    );
    if (kept.length === 0) this.opens.delete(boxId);
    else this.opens.set(boxId, kept);
    return kept;
  }
}

/** Process-wide budget: both mirror paths run in the same host relay process. */
export const browserOpenBudget = new BrowserOpenBudget();
