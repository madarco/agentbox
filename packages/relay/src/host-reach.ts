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
  /**
   * Which poller took it. A restarted relay is a NEW process with a new id, and
   * the work its predecessor accepted but never finished must be re-offered to
   * it — otherwise the box waits forever on a result nobody is going to post,
   * invisible to the went-away sweep because the replacement poller keeps this
   * machine "reachable". Seen live: a `relay restart` mid-copy hung the box.
   */
  deliveredTo?: string;
  /** Pollers that refused this action; never offered to them again. */
  declinedBy?: Set<string>;
  /** Grace timer, cleared on delivery and re-armed on a decline. */
  timer?: ReturnType<typeof setTimeout>;
}

interface Waiter {
  resolve: (actions: HostAction[]) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Identity of the polling process, for the orphan re-offer above. */
  pollerId?: string;
}

export class HostReachQueue {
  private readonly map = new Map<string, Pending>();
  private readonly waiters = new Set<Waiter>();
  private readonly reachTimeoutMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private lastPollAtMs: number | null = null;
  /** pollerId → last poll time, so "did the owner of this copy go away?" is answerable. */
  private readonly pollerSeen = new Map<string, number>();
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
  poll(timeoutMs: number, pollerId?: string): Promise<HostAction[]> {
    this.lastPollAtMs = this.now();
    if (pollerId !== undefined) this.pollerSeen.set(pollerId, this.lastPollAtMs);
    const ready = this.takeUndelivered(pollerId);
    if (ready.length > 0) return Promise.resolve(ready);
    return new Promise<HostAction[]>((resolve) => {
      const waiter: Waiter = {
        resolve,
        pollerId,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve([]);
        }, timeoutMs),
      };
      // NOT unref'd, unlike the grace/sweep timers: this one is the deadline of
      // an in-flight HTTP request, and an unref'd timer does not fire on an
      // otherwise-idle loop — the long poll would then never answer.
      this.waiters.add(waiter);
    });
  }

  /**
   * Settle a parked action with the machine's result. Returns whether it matched.
   *
   * `pollerId`, when given, must be the poller the action was handed to: after a
   * re-offer the previous owner may still be running, and letting its late
   * result land would settle the box's request with the answer of a machine that
   * no longer owns the copy.
   */
  resolve(id: string, result: HostActionResult, pollerId?: string): boolean {
    const pending = this.map.get(id);
    if (!pending) return false;
    if (
      pollerId !== undefined &&
      pending.deliveredTo !== undefined &&
      pending.deliveredTo !== pollerId
    ) {
      return false;
    }
    this.map.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.settle({ kind: 'result', result });
    return true;
  }

  /**
   * Hand an action back unexecuted, because the machine that took it does not
   * own that box.
   *
   * Settling it instead would be wrong with more than one machine on a hub: the
   * first poller to see fresh work is not necessarily the one holding the files,
   * and its "I don't know that box" would answer a question meant for someone
   * else. Declining returns the action to the pool, and the grace/heartbeat
   * timers still bound the case where *nobody* claims it.
   */
  decline(id: string, pollerId?: string): boolean {
    const pending = this.map.get(id);
    if (!pending) return false;
    if (
      pollerId !== undefined &&
      pending.deliveredTo !== undefined &&
      pending.deliveredTo !== pollerId
    ) {
      return false;
    }
    pending.delivered = false;
    pending.deliveredTo = undefined;
    // Never offer it back to the machine that just refused it: it would take,
    // decline, take again — a tight loop that also starves the fallback, since
    // the went-away sweep only looks at delivered work.
    if (pollerId !== undefined) (pending.declinedBy ??= new Set()).add(pollerId);
    // Delivery cleared the grace timer, so without re-arming it a declined
    // action could sit undelivered forever and the box would wait on a copy no
    // machine is ever going to make. Re-armed, an unclaimed decline falls
    // through to the cache / outbox / error like any other unreachable copy.
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.map.get(id) === pending && !pending.delivered) {
        this.map.delete(id);
        pending.settle({ kind: 'unreachable', reason: 'never-connected' });
      }
    }, this.graceMs);
    pending.timer.unref?.();
    // Another machine may already be waiting for work.
    this.handOff();
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
    // Every waiter gets a look: the first one may be the machine that just
    // declined this action, and stopping there would leave work parked while
    // another machine sits idle on an open poll.
    for (const waiter of [...this.waiters]) {
      const ready = this.takeUndelivered(waiter.pollerId);
      if (ready.length === 0) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(ready);
      return;
    }
  }

  private takeUndelivered(pollerId?: string): HostAction[] {
    const out: HostAction[] = [];
    const now = this.now();
    for (const pending of this.map.values()) {
      // Re-offer work whose owner has gone quiet — but only then. Handing an
      // in-flight copy to whichever poller asks next lets a second machine (or
      // an old process still finishing) claim it, answer "I don't know that box"
      // (exit 69), and settle the request; the real machine's success then
      // arrives with nowhere to go. So an owner that is still polling keeps its
      // work, however long the user takes to answer its confirm.
      const owner = pending.deliveredTo;
      const ownerSeenAt = owner === undefined ? undefined : this.pollerSeen.get(owner);
      const ownerGone =
        owner !== undefined &&
        owner !== pollerId &&
        (ownerSeenAt === undefined || now - ownerSeenAt > this.reachTimeoutMs);
      const orphaned = pending.delivered && pollerId !== undefined && ownerGone;
      if (pending.delivered && !orphaned) continue;
      // A machine that already refused this action does not get asked twice.
      if (pollerId !== undefined && pending.declinedBy?.has(pollerId)) continue;
      pending.delivered = true;
      pending.deliveredTo = pollerId;
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
    const now = this.now();
    for (const [id, pending] of this.map) {
      if (!pending.delivered) continue;
      // Ask whether THIS action's owner is still alive, not whether anyone is.
      // A global "someone polled recently" check hangs the box whenever another
      // machine keeps polling: the owner is gone, the survivor already declined
      // the work (or does not hold the box), and nothing settles it.
      const owner = pending.deliveredTo;
      const seenAt = owner === undefined ? this.lastPollAtMs : (this.pollerSeen.get(owner) ?? null);
      if (seenAt !== null && now - seenAt <= this.reachTimeoutMs) continue;
      // Offer it before declaring it lost. A relay that restarted mid-copy is
      // sitting in its long poll right now, and `takeUndelivered` only runs when
      // a poll *arrives* — so without this the box fails over to the cache while
      // the machine that owns the files waits, connected, for work to appear.
      pending.delivered = false;
      pending.deliveredTo = undefined;
      this.handOff();
      if (this.map.get(id) !== pending || pending.delivered) continue;
      this.map.delete(id);
      pending.settle({ kind: 'unreachable', reason: 'went-away' });
    }
  }
}
