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
export type HostReachUnreachable = 'never-connected' | 'went-away' | 'declined';

/** One machine a routed action was meant for, and why it did not answer. */
export interface HostReachTried {
  deviceId: string;
  /** Display label of that machine, when the hub knows one. */
  label?: string;
  /**
   * `declined`: it took the action and handed it back (no checkout, unknown box);
   * `went-away`: it took it and stopped polling; `offline`: never connected
   * while the action waited.
   */
  reason: 'declined' | 'went-away' | 'offline';
  /** What the machine said when it declined. */
  detail?: string;
}

export type HostReachOutcome =
  | { kind: 'result'; result: HostActionResult }
  | { kind: 'unreachable'; reason: HostReachUnreachable; tried?: HostReachTried[] };

/**
 * A machine allowed to serve a routed action, in the order to try
 * (`hostCandidatesFor`): the box's origin PC, then other PCs with a checkout.
 */
export interface HostReachCandidate {
  deviceId: string;
  label?: string;
  /**
   * `origin`: the PC the box was created from (serves any path it may);
   * `has-repo`: another PC with a checkout, which serves only paths inside
   * that checkout. Handed to the machine with the action.
   */
  role?: 'origin' | 'has-repo';
  /** That machine's checkout of the box's repo, handed to it with the action. */
  folder?: string;
}

/**
 * Where an action may go (multi-PC Phase 4). Without one, any poller may take
 * it (a box registered before origin machines and checkouts existed).
 */
export interface HostReachRoute {
  candidates: HostReachCandidate[];
  repoKey?: string;
  /**
   * The box as the hub knows it, so a PC that has no record of it can still
   * show a confirm and run the copy (it adopts the box only once approved).
   */
  box?: HostReachBox;
}

/** What a PC needs to serve a box it has no record of yet. */
export interface HostReachBox {
  name: string;
  backend?: string;
  /** The box's origin machine, so that machine knows the box is its own. */
  originMachineId?: string;
  /** `box.autoApproveSafeHostActions` from the registration (absent = enabled). */
  autoApproveSafeHostActions?: boolean;
  /** The agent the box was created for (its registration's), for `agents.list`. */
  agent?: string;
}

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
  /** Called once an action is settled, however (result, unreachable, stop). */
  onSettle?: (id: string) => void;
  /**
   * Called when an action is taken back from the poller that held it (that
   * machine went silent) to be offered again, so anything that poller raised
   * for it (a mirrored confirm) can be withdrawn.
   */
  onReoffer?: (id: string, previousPollerId: string) => void;
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
  /** Routed actions only: the candidates, and the devices already tried. */
  route?: HostReachRoute;
  tried?: Map<string, { reason: 'declined' | 'went-away'; detail?: string }>;
}

interface Waiter {
  resolve: (actions: HostAction[]) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Identity of the polling process, for the orphan re-offer above. */
  pollerId?: string;
}

/** A machine holding an open stream. Unlike a waiter, delivery does not consume it. */
interface Subscriber {
  pollerId: string;
  deliver: (actions: HostAction[]) => void;
}

export class HostReachQueue {
  private readonly map = new Map<string, Pending>();
  private readonly waiters = new Set<Waiter>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly reachTimeoutMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private readonly onSettle: ((id: string) => void) | undefined;
  private readonly onReoffer: ((id: string, previousPollerId: string) => void) | undefined;
  private lastPollAtMs: number | null = null;
  /** pollerId → last poll time, so "did the owner of this copy go away?" is answerable. */
  private readonly pollerSeen = new Map<string, number>();
  /**
   * pollerId → the device (machine id) that poller runs on. The seam for routing
   * an action to the PC a box came from (multi-PC Phase 4): today every eligible
   * poller is offered every action, and this is only recorded and reported.
   */
  private readonly pollerDevice = new Map<string, string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HostReachQueueOptions = {}) {
    this.reachTimeoutMs = opts.reachTimeoutMs ?? DEFAULT_HOST_REACH_TIMEOUT_MS;
    this.graceMs = opts.graceMs ?? this.reachTimeoutMs;
    this.now = opts.now ?? ((): number => Date.now());
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 5_000;
    this.onSettle = opts.onSettle;
    this.onReoffer = opts.onReoffer;
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
    opts: { cachePrefix?: string; route?: HostReachRoute } = {},
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
    return new Promise<HostReachOutcome>((done) => {
      const resolve = (outcome: HostReachOutcome): void => {
        done(outcome);
        this.onSettle?.(id);
      };
      const pending: Pending = { action, settle: resolve, delivered: false };
      if (opts.route) {
        pending.route = opts.route;
        pending.tried = new Map();
        // No machine may serve it: nothing to wait for, go straight to the
        // caller's fallback (the cache) and its error.
        if (opts.route.candidates.length === 0) {
          resolve(this.unreachable(pending, 'never-connected'));
          return;
        }
      }
      this.armGrace(pending, 'never-connected');
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
   * Register a machine that stays connected (the SSE stream) instead of asking
   * again after every batch.
   *
   * A subscriber is modelled as a **waiter that is never consumed**: the same
   * eligibility, ownership, decline and orphan rules apply, because they are the
   * same code path. That is deliberate — those rules took four review rounds to
   * get right, and a second delivery mechanism with its own copy of them would
   * be the obvious place for the fifth bug to live.
   *
   * Returns an unsubscribe. Call {@link touch} while the connection is alive so
   * presence does not lapse on a quiet stream.
   */
  subscribe(pollerId: string, deliver: (actions: HostAction[]) => void): () => void {
    this.touch(pollerId);
    const subscriber: Subscriber = { pollerId, deliver };
    this.subscribers.add(subscriber);
    // Whatever is already queued and eligible goes out now: a machine that
    // reconnects mid-copy should not wait for the next action to arrive.
    const ready = this.takeUndelivered(pollerId);
    if (ready.length > 0) deliver(ready);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Mark a machine present without handing it anything — what an SSE heartbeat
   * means. Presence is what decides whether a copy waits for that machine or
   * falls back, so a live-but-quiet stream must keep it fresh.
   */
  /**
   * Record which device a poller runs on (see {@link pollerDevice}). The
   * pollerId is chosen by the client, so a later call can relabel it; harmless
   * while this is only reported. Phase 4 routing must bind a pollerId to the
   * first verified device that used it before trusting the mapping.
   */
  identify(pollerId: string, deviceId: string): boolean {
    if (!deviceId) return true;
    const bound = this.pollerDevice.get(pollerId);
    // Bound to the FIRST device that used it: poller ids are chosen by the
    // client, and routing hands a device its own work, so a second device
    // reusing an id must not inherit the first one's queue.
    if (bound !== undefined) return bound === deviceId;
    // The sweep only runs while actions are parked; an idle queue prunes here.
    this.prunePollers();
    this.pollerDevice.set(pollerId, deviceId);
    return true;
  }

  /** The device a poller is bound to (see {@link identify}). */
  deviceOf(pollerId: string): string | undefined {
    return this.pollerDevice.get(pollerId);
  }

  /** Who holds a parked action right now, for routes that act on its behalf. */
  ownerOf(id: string): { boxId: string; pollerId?: string } | undefined {
    const pending = this.map.get(id);
    if (!pending) return undefined;
    return {
      boxId: pending.action.boxId,
      ...(pending.deliveredTo !== undefined ? { pollerId: pending.deliveredTo } : {}),
    };
  }

  /**
   * Whether `deviceId` is present: it holds an open event stream (the
   * connection IS its presence, whatever the heartbeat interval), or a poller
   * of it polled within the reachability window.
   */
  private devicePresent(deviceId: string): boolean {
    for (const sub of this.subscribers) {
      if (this.pollerDevice.get(sub.pollerId) === deviceId) return true;
    }
    const now = this.now();
    for (const [pollerId, dev] of this.pollerDevice) {
      if (dev !== deviceId) continue;
      const seen = this.pollerSeen.get(pollerId);
      if (seen !== undefined && now - seen <= this.reachTimeoutMs) return true;
    }
    return false;
  }

  /**
   * The device a routed action is offered to now: the first candidate not yet
   * tried that has a poller present. Undefined when none is (the action waits
   * out its grace window, or fails fast once every candidate is tried).
   */
  private currentTarget(pending: Pending): string | undefined {
    for (const c of pending.route?.candidates ?? []) {
      if (pending.tried?.has(c.deviceId)) continue;
      if (this.devicePresent(c.deviceId)) return c.deviceId;
    }
    return undefined;
  }

  /** May `pollerId` take this action? The one eligibility rule every delivery path uses. */
  private eligible(pending: Pending, pollerId: string | undefined): boolean {
    if (pollerId !== undefined && pending.declinedBy?.has(pollerId)) return false;
    if (!pending.route) return true;
    // A routed action goes only to a verified device, and only to the current one.
    const device = pollerId === undefined ? undefined : this.pollerDevice.get(pollerId);
    return device !== undefined && device === this.currentTarget(pending);
  }

  /** The action as handed to `pollerId`: a routed one carries that machine's own checkout. */
  private forPoller(pending: Pending, pollerId: string | undefined): HostAction {
    if (!pending.route) return pending.action;
    const device = pollerId === undefined ? undefined : this.pollerDevice.get(pollerId);
    const mine = pending.route.candidates.find((c) => c.deviceId === device);
    return {
      ...pending.action,
      route: {
        ...(pending.route.repoKey ? { repoKey: pending.route.repoKey } : {}),
        ...(mine?.folder ? { folder: mine.folder } : {}),
        ...(mine?.role ? { role: mine.role } : {}),
        ...(pending.route.box ? { box: pending.route.box } : {}),
      },
    };
  }

  /** Every candidate is tried: nothing is left to wait for. */
  private exhausted(pending: Pending): boolean {
    const route = pending.route;
    return route !== undefined && route.candidates.every((c) => pending.tried?.has(c.deviceId));
  }

  private unreachable(pending: Pending, reason: HostReachUnreachable): HostReachOutcome {
    if (!pending.route) return { kind: 'unreachable', reason };
    const tried: HostReachTried[] = pending.route.candidates.map((c) => {
      const t = pending.tried?.get(c.deviceId);
      return {
        deviceId: c.deviceId,
        ...(c.label ? { label: c.label } : {}),
        reason: t?.reason ?? 'offline',
        ...(t?.detail ? { detail: t.detail } : {}),
      };
    });
    return { kind: 'unreachable', reason, tried };
  }

  /**
   * Forget pollers gone for well past the grace window. Every relay restart is a
   * new pollerId, so without this a long-lived control box would keep them all.
   * Pollers that still own an action are kept (the went-away sweep needs them).
   */
  private prunePollers(): void {
    const cutoff = this.now() - Math.max(this.reachTimeoutMs, this.graceMs) * 2;
    const owners = new Set<string>();
    for (const p of this.map.values()) if (p.deliveredTo !== undefined) owners.add(p.deliveredTo);
    for (const [pollerId, seen] of this.pollerSeen) {
      if (seen >= cutoff || owners.has(pollerId)) continue;
      this.pollerSeen.delete(pollerId);
      this.pollerDevice.delete(pollerId);
    }
  }

  /** The devices with a poller present within the reachability window. */
  devicesPresent(): string[] {
    const now = this.now();
    const out = new Set<string>();
    for (const [pollerId, deviceId] of this.pollerDevice) {
      const seen = this.pollerSeen.get(pollerId);
      if (seen !== undefined && now - seen <= this.reachTimeoutMs) out.add(deviceId);
    }
    return [...out];
  }

  touch(pollerId: string): void {
    const now = this.now();
    this.lastPollAtMs = now;
    this.pollerSeen.set(pollerId, now);
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
    // A routed action is answered only by the poller it was handed to: without
    // a poller id any machine could settle another machine's copy.
    if (pending.route && (pollerId === undefined || pending.deliveredTo !== pollerId)) return false;
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
  decline(id: string, pollerId?: string, detail?: string): boolean {
    const pending = this.map.get(id);
    if (!pending) return false;
    if (pending.route && (pollerId === undefined || pending.deliveredTo !== pollerId)) return false;
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
    // A routed action moves on to the next machine: the one that declined has
    // no checkout of this repo (or no record of the box), and asking it again
    // would only get the same answer.
    const device = pollerId === undefined ? undefined : this.pollerDevice.get(pollerId);
    if (pending.route && device !== undefined) {
      pending.tried?.set(device, { reason: 'declined', ...(detail ? { detail } : {}) });
      if (this.exhausted(pending)) {
        this.map.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        pending.settle(this.unreachable(pending, 'declined'));
        return true;
      }
    }
    // Delivery cleared the grace timer, so without re-arming it a declined
    // action could sit undelivered forever and the box would wait on a copy no
    // machine is ever going to make. Re-armed, an unclaimed decline falls
    // through to the cache / outbox / error like any other unreachable copy.
    this.armGrace(pending, 'never-connected');
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
    this.subscribers.clear();
    for (const [id, pending] of this.map) {
      this.map.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.settle({ kind: 'unreachable', reason: 'went-away' });
    }
  }

  /** Hand any undelivered actions to a waiting poller. */
  private handOff(): void {
    // Streams first: a subscriber is already connected, so handing work there
    // costs nothing and leaves the one-shot waiters for machines that are
    // between polls.
    for (const sub of [...this.subscribers]) {
      const ready = this.takeUndelivered(sub.pollerId);
      if (ready.length === 0) continue;
      this.pollerSeen.set(sub.pollerId, this.now());
      sub.deliver(ready);
      return;
    }
    // Every waiter gets a look: the first one may be the machine that just
    // declined this action, and stopping there would leave work parked while
    // another machine sits idle on an open poll.
    for (const waiter of [...this.waiters]) {
      const ready = this.takeUndelivered(waiter.pollerId);
      if (ready.length === 0) continue;
      if (waiter.pollerId !== undefined) this.pollerSeen.set(waiter.pollerId, this.now());
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(ready);
      return;
    }
  }

  /**
   * Hand one specific action to any waiting poller eligible for it (i.e. one
   * that has not refused it). Returns whether it found a taker.
   */
  private offerToWaiter(pending: Pending): boolean {
    for (const sub of [...this.subscribers]) {
      if (!this.eligible(pending, sub.pollerId)) continue;
      pending.delivered = true;
      pending.deliveredTo = sub.pollerId;
      this.pollerSeen.set(sub.pollerId, this.now());
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      }
      sub.deliver([this.forPoller(pending, sub.pollerId), ...this.takeUndelivered(sub.pollerId)]);
      return true;
    }
    for (const waiter of [...this.waiters]) {
      const pid = waiter.pollerId;
      if (!this.eligible(pending, pid)) continue;
      pending.delivered = true;
      pending.deliveredTo = pid;
      // Handing work to a waiter IS contact with that machine: without this the
      // next sweep judges it by a stale heartbeat and takes back the copy it was
      // just given.
      if (pid !== undefined) this.pollerSeen.set(pid, this.now());
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      }
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      // Anything else that poller may take rides along, so it is not left
      // waiting a full cycle for work already queued.
      waiter.resolve([this.forPoller(pending, pid), ...this.takeUndelivered(pid)]);
      return true;
    }
    return false;
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
      if (orphaned) {
        this.noteOwnerGone(pending);
        this.onReoffer?.(pending.action.id, owner);
      }
      // A machine that already refused this action does not get asked twice,
      // and a routed one goes only to its current target device.
      if (!this.eligible(pending, pollerId)) continue;
      pending.delivered = true;
      pending.deliveredTo = pollerId;
      // Delivery ends the grace window: from here the wait is unbounded, and
      // only the went-away sweep can cut it short.
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      }
      out.push(this.forPoller(pending, pollerId));
    }
    return out;
  }

  /**
   * The poller that owned a routed action stopped polling. When its whole
   * device is gone (not a relay restart on the same machine, which polls again
   * under a new id), that device is tried and the action moves to the next one.
   */
  private noteOwnerGone(pending: Pending): void {
    if (!pending.route || pending.deliveredTo === undefined) return;
    const device = this.pollerDevice.get(pending.deliveredTo);
    if (device !== undefined && !this.devicePresent(device)) {
      pending.tried?.set(device, { reason: 'went-away' });
    }
  }

  /**
   * (Re)start an undelivered action's grace window. When it ends, a routed
   * action first goes to whichever candidate is present NOW (the one it was
   * waiting for may have lapsed meanwhile, which no poll announces), and keeps
   * waiting while one is; only then does it settle as unreachable.
   */
  private armGrace(pending: Pending, reason: HostReachUnreachable): void {
    const id = pending.action.id;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.map.get(id) !== pending || pending.delivered) return;
      if (pending.route && !this.exhausted(pending)) {
        if (this.offerToWaiter(pending)) return;
        if (this.currentTarget(pending) !== undefined) {
          this.armGrace(pending, reason);
          return;
        }
      }
      this.map.delete(id);
      pending.settle(this.unreachable(pending, reason));
    }, this.graceMs);
    // Node keeps the process alive for pending timers; a parked copy must not
    // be what holds a relay open on shutdown.
    pending.timer.unref?.();
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
    this.prunePollers();
    if (this.map.size === 0) {
      if (this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
      return;
    }
    const now = this.now();
    for (const [id, pending] of this.map) {
      if (!pending.delivered) {
        // The device a routed action was waiting for can lapse with nothing
        // announcing it (a killed relay sends no goodbye): offer it to the
        // candidate that is present now, which may already be connected.
        if (pending.route) this.offerToWaiter(pending);
        continue;
      }
      // Ask whether THIS action's owner is still alive, not whether anyone is.
      // A global "someone polled recently" check hangs the box whenever another
      // machine keeps polling: the owner is gone, the survivor already declined
      // the work (or does not hold the box), and nothing settles it.
      const owner = pending.deliveredTo;
      const seenAt = owner === undefined ? this.lastPollAtMs : (this.pollerSeen.get(owner) ?? null);
      if (seenAt !== null && now - seenAt <= this.reachTimeoutMs) continue;
      // Offer THIS action before declaring it lost. A relay that restarted
      // mid-copy is sitting in its long poll right now, and `takeUndelivered`
      // only runs when a poll *arrives* — so without an offer the box fails over
      // to the cache while the machine that owns the files waits, connected, for
      // work to appear. Targeted rather than a generic hand-off, because that
      // stops at the first waiter to receive *anything*: with two orphans in
      // flight it can hand a waiter the other one and leave this one looking
      // unclaimed while an eligible machine is still listening.
      this.noteOwnerGone(pending);
      if (owner !== undefined) this.onReoffer?.(id, owner);
      pending.delivered = false;
      pending.deliveredTo = undefined;
      if (!this.exhausted(pending) && this.offerToWaiter(pending)) continue;
      // A routed action with another candidate present (between polls, so no
      // waiter right now) waits for that machine's next poll, under a fresh
      // grace window, instead of failing over to the cache.
      if (pending.route && this.currentTarget(pending) !== undefined) {
        this.armGrace(pending, 'went-away');
        continue;
      }
      this.map.delete(id);
      pending.settle(this.unreachable(pending, 'went-away'));
    }
  }
}
