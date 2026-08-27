/**
 * `HostReachQueue` — the control box's parking lot for host actions that can
 * only be executed on the user's own machine.
 *
 * The mirror image of {@link HostActionQueue}. There, an in-sandbox relay parks
 * an RPC and the *host* polls in to drain it. Here, a control box parks an RPC
 * and the *PC* polls in — over `/admin/hostreach/*`, authenticated with the
 * admin token — executes it against the real project files, and posts the result
 * back.
 *
 * Why a second queue instead of reusing the first: this one has to answer a
 * question the box-mode queue never faces — **is the other machine there at
 * all?** A cloud box asking for a file from a laptop that is closed must get a
 * useful answer in seconds, not block on a 15-minute expiry. So reachability is
 * modelled explicitly:
 *
 * - Nobody has polled within `reachTimeoutMs` and none arrives within
 *   `graceMs` → `unreachable: 'never-connected'`. The caller decides what that
 *   means (serve a cached copy, or fail with an actionable message).
 * - A poller took the action and then stopped polling for `reachTimeoutMs` →
 *   `unreachable: 'went-away'`. The PC long-polls continuously while it lives,
 *   so silence is the only honest signal that it died mid-copy.
 * - A poller took it and is still polling → wait indefinitely. The copy is
 *   sitting behind a human approval on that machine, and cutting it off after
 *   an arbitrary timeout would be worse than waiting (matches the no-TTL
 *   semantics of every other parked approval).
 */

import { randomUUID } from 'node:crypto';
import type { HostAction, HostActionResult } from './types.js';

/** Why a request could not be handed to a machine. Both are recoverable. */
export type HostReachUnreachable = 'never-connected' | 'went-away';

export type HostReachOutcome =
  | { kind: 'result'; result: HostActionResult }
  | { kind: 'unreachable'; reason: HostReachUnreachable };

/**
 * Default reachability window. A poller re-polls every long-poll cycle (~25s),
 * so 60s tolerates one missed cycle plus a slow network before declaring the
 * machine gone.
 */
export const DEFAULT_HOST_REACH_TIMEOUT_MS = 60_000;

export interface HostReachQueueOptions {
  /** Silence longer than this means "that machine is gone". */
  reachTimeoutMs?: number;
  /**
   * How long a fresh request waits for a first poll before giving up. Defaults
   * to `reachTimeoutMs`. Only applies while the action is undelivered — once a
   * machine takes it, the wait is unbounded.
   */
  graceMs?: number;
  /** Clock injector (tests). */
  now?: () => number;
  /** Sweep interval for the went-away check. Tests pass a small value. */
  sweepIntervalMs?: number;
}

interface Pending {
  action: HostAction;
  settle: (outcome: HostReachOutcome) => void;
  /** True once a poll handed this action out. */
  delivered: boolean;
  /** Grace timer, cleared on delivery. */
  timer?: ReturnType<typeof setTimeout>;
}

interface Waiter {
  resolve: (actions: HostAction[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HostReachQueue {
  private readonly map = new Map<string, Pending>();
  private readonly waiters = new Set<Waiter>();
  private readonly reachTimeoutMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private lastPollAtMs: number | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HostReachQueueOptions = {}) {
    this.reachTimeoutMs = opts.reachTimeoutMs ?? DEFAULT_HOST_REACH_TIMEOUT_MS;
    this.graceMs = opts.graceMs ?? this.reachTimeoutMs;
    this.now = opts.now ?? ((): number => Date.now());
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 5_000;
  }

  /** Whether a machine has polled recently enough to be considered present. */
  reachable(): boolean {
    if (this.lastPollAtMs === null) return false;
    return this.now() - this.lastPollAtMs <= this.reachTimeoutMs;
  }

  /** Epoch ms of the last poll, or null when no machine has ever connected. */
  lastPollAt(): number | null {
    return this.lastPollAtMs;
  }

  /**
   * Park an action for the user's machine and wait for its result.
   *
   * Resolves with `unreachable` rather than rejecting: "no machine there" is a
   * normal, expected state (a closed laptop), not an error condition.
   */
  request(
    boxId: string,
    method: string,
    params: unknown,
    opts: { cachePrefix?: string } = {},
  ): Promise<HostReachOutcome> {
    const id = randomUUID();
    const action: HostAction = {
      id,
      boxId,
      method,
      params,
      createdAt: new Date(this.now()).toISOString(),
      ...(opts.cachePrefix ? { cachePrefix: opts.cachePrefix } : {}),
    };
    return new Promise<HostReachOutcome>((resolve) => {
      const pending: Pending = { action, settle: resolve, delivered: false };
      pending.timer = setTimeout(() => {
        // Still undelivered after the grace window: nobody is listening.
        if (this.map.get(id) === pending && !pending.delivered) {
          this.map.delete(id);
          resolve({ kind: 'unreachable', reason: 'never-connected' });
        }
      }, this.graceMs);
      // Node keeps the process alive for pending timers; a parked copy must not
      // be what holds a relay open on shutdown.
      pending.timer.unref?.();
      this.map.set(id, pending);
      this.ensureSweep();
      this.handOff();
    });
  }

  /**
   * Long-poll entry point: resolve with every undelivered action, waiting up to
   * `timeoutMs` for one to appear. An empty array means "nothing for you right
   * now" — the poller simply polls again.
   *
   * Calling this marks the machine present, whether or not anything is queued:
   * an idle poll is exactly how a laptop says "I'm here".
   */
  poll(timeoutMs: number): Promise<HostAction[]> {
    this.lastPollAtMs = this.now();
    const ready = this.takeUndelivered();
    if (ready.length > 0) return Promise.resolve(ready);
    return new Promise<HostAction[]>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve([]);
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  /** Settle a parked action with the machine's result. Returns whether it matched. */
  resolve(id: string, result: HostActionResult): boolean {
    const pending = this.map.get(id);
    if (!pending) return false;
    this.map.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.settle({ kind: 'result', result });
    return true;
  }

  size(): number {
    return this.map.size;
  }

  /** Test/diagnostic: the parked action with this id (undefined once settled). */
  peek(id: string): HostAction | undefined {
    return this.map.get(id)?.action;
  }

  /** Release timers + fail every parked action, so a relay can shut down cleanly. */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.waiters.clear();
    for (const [id, pending] of this.map) {
      this.map.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.settle({ kind: 'unreachable', reason: 'went-away' });
    }
  }

  /** Hand any undelivered actions to a waiting poller. */
  private handOff(): void {
    if (this.waiters.size === 0) return;
    const ready = this.takeUndelivered();
    if (ready.length === 0) return;
    const [waiter] = this.waiters;
    if (!waiter) return;
    this.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(ready);
  }

  private takeUndelivered(): HostAction[] {
    const out: HostAction[] = [];
    for (const pending of this.map.values()) {
      if (pending.delivered) continue;
      pending.delivered = true;
      // Delivery ends the grace window: from here the wait is unbounded, and
      // only the went-away sweep can cut it short.
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      }
      out.push(pending.action);
    }
    return out;
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /**
   * Fail delivered-but-unanswered actions once the machine that took them has
   * stopped polling. Without this a laptop that sleeps mid-copy leaves the box
   * blocked forever on an RPC nobody will ever answer.
   */
  private sweep(): void {
    if (this.map.size === 0) {
      if (this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
      return;
    }
    if (this.reachable()) return;
    for (const [id, pending] of this.map) {
      if (!pending.delivered) continue;
      this.map.delete(id);
      pending.settle({ kind: 'unreachable', reason: 'went-away' });
    }
  }
}
