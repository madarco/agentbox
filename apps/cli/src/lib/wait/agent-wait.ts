// The wait loop behind `agentbox agent wait-for`, with every dependency
// injected so it is unit-testable without a hub — see test/agent-wait.test.ts.
//
// Two things it exists to get right, both learned from a real orchestration run
// that lost a 50-minute wait when the relay was restarted underneath it:
//
//   1. A hub that goes away mid-wait is NOT the end of the wait. `hub restart`,
//      `hub update` and a sleeping laptop all produce a `fetch failed` for a few
//      seconds; the box's state is durable on the hub's disk, so the right
//      answer is to back off, reconnect, and keep waiting until the wall clock
//      the caller asked for actually runs out.
//   2. "The hub never answered" and "the agent never reached the state" are
//      different outcomes and must not share an exit code — a caller has to be
//      able to tell "my relay died" from "my agent is still working".

import type { AgentStatusEntry } from '@agentbox/ctl';
import { matchesAgentWaitState, type AgentWaitState } from './agent-state.js';

/** Healthy cadence between reads — unchanged from the original poll loop. */
const POLL_INTERVAL_MS = 500;
const INITIAL_BACKOFF_MS = 250;
/**
 * Backoff ceiling. Lower than the attach stream's 30s (`prompt-client.ts`)
 * because this is a poll, not a socket: a 30s cap would add up to 30s of
 * latency between the hub coming back and the wait noticing a match.
 */
const MAX_BACKOFF_MS = 5_000;
/** Consecutive transient failures before the caller is asked to re-resolve the hub. */
const STALE_AFTER_FAILURES = 3;
/** Floor between two re-resolves of the same target (each may start a hub). */
const RERESOLVE_MIN_INTERVAL_MS = 15_000;
/**
 * How long a box that HAS answered is allowed to 404 before we believe it.
 * A hub's box registry rehydrates from the durable store after a restart, so a
 * stream can briefly outrun it — but a box destroyed mid-wait must still be
 * reported as gone rather than waited out to the timeout.
 */
const NOT_FOUND_GRACE_MS = 15_000;
const NOT_FOUND_GRACE_READS = 5;

export type HubFailureKind = 'unauthorized' | 'not-found' | 'transient';

/**
 * Classify a failed hub read. Duck-typed on `code`/`status` rather than
 * `instanceof HubApiError` so this module stays dependency-free (and so a test
 * can hand it a plain object).
 *
 * Everything unrecognised is transient ON PURPOSE: an undici network failure
 * escapes `HubApiClient.request` as a bare `TypeError: fetch failed` with no
 * fields at all, and that is the exact case this loop has to survive.
 */
export function classifyHubFailure(err: unknown): HubFailureKind {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    status?: unknown;
  };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (code === 'unauthorized' || status === 401 || status === 403) return 'unauthorized';
  if (code === 'not_found') return 'not-found';
  return 'transient';
}

/** One box being waited on. `box` is the caller's handle, returned untouched. */
export interface WaitTarget<B> {
  id: string;
  name: string;
  box: B;
}

export type WaitNotice<B> =
  | { kind: 'unreachable'; target: WaitTarget<B>; message: string }
  | { kind: 'recovered'; target: WaitTarget<B> };

export type AgentWaitResult<B> =
  | { kind: 'matched'; target: WaitTarget<B>; entry: AgentStatusEntry; elapsedMs: number }
  | { kind: 'timeout'; elapsedMs: number }
  | { kind: 'unreachable'; elapsedMs: number; lastError: string }
  | {
      kind: 'fatal';
      reason: 'not-found' | 'unauthorized';
      target: WaitTarget<B>;
      message: string;
    };

export interface AgentWaitArgs<B> {
  targets: readonly WaitTarget<B>[];
  state: AgentWaitState;
  timeoutMs: number;
  /** Read one target's agent snapshot. Rejects the way the hub client does. */
  read: (target: WaitTarget<B>) => Promise<AgentStatusEntry | null>;
  /**
   * Re-resolve a target's hub after repeated transient failures — this is what
   * restarts a local hub that actually died.
   *
   * `'unreachable'` does NOT end the wait: a hub that can't be brought up right
   * now is the exact case the caller asked us to sit through, and the deadline
   * is what decides. Only `'unauthorized'` (a plane we hold no key for — no
   * amount of waiting conjures a credential) is terminal.
   */
  onStale?: (target: WaitTarget<B>) => Promise<'ok' | 'unreachable' | 'unauthorized'>;
  /** One line when a target first goes unreachable, one when it comes back. */
  onNotice?: (notice: WaitNotice<B>) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface TargetState {
  /** A target that has never answered is not given the benefit of the doubt. */
  everAnswered: boolean;
  failing: boolean;
  consecutiveFailures: number;
  backoffMs: number;
  nextAttemptAt: number;
  notFoundSince?: number;
  notFoundReads: number;
  lastReResolveAt: number;
  lastError?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runAgentWait<B>(args: AgentWaitArgs<B>): Promise<AgentWaitResult<B>> {
  const now = args.now ?? (() => Date.now());
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = args.random ?? Math.random;
  const notify = args.onNotice ?? ((): void => {});

  const start = now();
  const deadline = start + args.timeoutMs;
  const states = new Map<string, TargetState>(
    args.targets.map((t) => [
      t.id,
      {
        everAnswered: false,
        failing: false,
        consecutiveFailures: 0,
        backoffMs: INITIAL_BACKOFF_MS,
        nextAttemptAt: start,
        notFoundReads: 0,
        lastReResolveAt: 0,
      },
    ]),
  );

  for (;;) {
    for (const target of args.targets) {
      const st = states.get(target.id);
      if (!st) continue;
      if (now() < st.nextAttemptAt) continue;

      let entry: AgentStatusEntry | null;
      try {
        entry = await args.read(target);
      } catch (err) {
        const fatal = await onFailure(target, st, err);
        if (fatal) return fatal;
        continue;
      }

      st.everAnswered = true;
      st.notFoundSince = undefined;
      st.notFoundReads = 0;
      st.backoffMs = INITIAL_BACKOFF_MS;
      st.consecutiveFailures = 0;
      st.nextAttemptAt = now() + POLL_INTERVAL_MS;
      if (st.failing) {
        st.failing = false;
        st.lastError = undefined;
        notify({ kind: 'recovered', target });
      }
      if (entry && matchesAgentWaitState(entry, args.state)) {
        return { kind: 'matched', target, entry, elapsedMs: now() - start };
      }
    }

    const elapsed = now() - start;
    if (elapsed >= args.timeoutMs) break;

    // Wake for whichever target is due first, but never sit past the deadline.
    const soonest = Math.min(...[...states.values()].map((s) => s.nextAttemptAt));
    const wait = Math.max(0, Math.min(soonest - now(), deadline - now()));
    await sleep(wait);
  }

  const all = [...states.values()];
  const elapsedMs = now() - start;
  if (all.length > 0 && all.every((s) => s.failing)) {
    return {
      kind: 'unreachable',
      elapsedMs,
      lastError: all.find((s) => s.lastError !== undefined)?.lastError ?? 'the hub did not answer',
    };
  }
  return { kind: 'timeout', elapsedMs };

  /** Book a failed read. Returns a terminal result when the failure is fatal. */
  async function onFailure(
    target: WaitTarget<B>,
    st: TargetState,
    err: unknown,
  ): Promise<AgentWaitResult<B> | null> {
    const kind = classifyHubFailure(err);
    if (kind === 'unauthorized') {
      return { kind: 'fatal', reason: 'unauthorized', target, message: message(err) };
    }
    if (kind === 'not-found') {
      if (!st.everAnswered) {
        return { kind: 'fatal', reason: 'not-found', target, message: message(err) };
      }
      st.notFoundReads += 1;
      st.notFoundSince ??= now();
      if (
        st.notFoundReads >= NOT_FOUND_GRACE_READS ||
        now() - st.notFoundSince >= NOT_FOUND_GRACE_MS
      ) {
        return { kind: 'fatal', reason: 'not-found', target, message: message(err) };
      }
    }

    st.consecutiveFailures += 1;
    st.lastError = message(err);
    if (!st.failing) {
      st.failing = true;
      notify({ kind: 'unreachable', target, message: st.lastError });
    }
    // Jitter across the top half of the window: several waiters pointed at the
    // same hub all lose it at the same instant, and un-jittered backoff would
    // march them back in lockstep.
    const delay = st.backoffMs / 2 + random() * (st.backoffMs / 2);
    st.backoffMs = Math.min(MAX_BACKOFF_MS, st.backoffMs * 2);
    st.nextAttemptAt = now() + delay;

    if (
      args.onStale &&
      st.consecutiveFailures % STALE_AFTER_FAILURES === 0 &&
      now() - st.lastReResolveAt >= RERESOLVE_MIN_INTERVAL_MS
    ) {
      st.lastReResolveAt = now();
      // This blocks (it may be starting a hub), so a wait can overshoot its
      // deadline by one hub-start attempt. Deliberate: cutting a recovery short
      // to honour the clock to the millisecond would defeat the point of it.
      if ((await args.onStale(target)) === 'unauthorized') {
        return { kind: 'fatal', reason: 'unauthorized', target, message: st.lastError };
      }
    }
    return null;
  }
}
