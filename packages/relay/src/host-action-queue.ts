/**
 * `HostActionQueue` — the box-mode relay's parking lot for host-only RPCs.
 * When the in-sandbox `/rpc` route receives `git.push` / `cp.*` / etc., it
 * cannot execute them locally (no host SSH keys, no host filesystem), so it
 * `enqueue`s and `await`s. The host's `CloudBoxPoller` drains via
 * `/bridge/poll`, executes on the host, and `resolve`s here via
 * `/bridge/action-result` — that resolves the awaited Promise and the
 * in-sandbox `/rpc` finally answers the in-box agent.
 *
 * Lifetime: per in-sandbox relay process; in-memory only. Actions outlive
 * individual polls (the queue is the source of truth, not the wire).
 */

import { randomUUID } from 'node:crypto';
import type { HostAction, HostActionResult } from './types.js';

interface Pending {
  action: HostAction;
  resolve: (r: HostActionResult) => void;
  /** True once a `/bridge/poll` has handed this action out. */
  delivered: boolean;
}

/**
 * Default max age for a parked action before it expires (15 minutes).
 * Picked to be longer than any reasonable interactive prompt + a host
 * restart window, but short enough that a forgotten queue doesn't replay
 * stale `git.push` attempts when the host relay rehydrates. Override per
 * queue instance for tests.
 */
export const DEFAULT_HOST_ACTION_MAX_AGE_MS = 15 * 60 * 1000;

export interface HostActionQueueOptions {
  /** Override the per-action expiry. Default {@link DEFAULT_HOST_ACTION_MAX_AGE_MS}. */
  maxAgeMs?: number;
  /** Clock injector (tests). */
  now?: () => number;
}

export class HostActionQueue {
  private readonly map = new Map<string, Pending>();
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(opts: HostActionQueueOptions = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_HOST_ACTION_MAX_AGE_MS;
    this.now = opts.now ?? ((): number => Date.now());
  }

  /**
   * Park a host-only RPC and return a Promise that resolves when the host
   * poller posts the result back. Caller should `await` and forward the
   * result to the in-box client; there's intentionally no client-side
   * timeout (matches the existing in-box `postRpc`'s "block while a prompt
   * is open" semantics).
   */
  enqueue(boxId: string, method: string, params: unknown): Promise<HostActionResult> {
    const id = randomUUID();
    const action: HostAction = {
      id,
      boxId,
      method,
      params,
      createdAt: new Date(this.now()).toISOString(),
    };
    return new Promise<HostActionResult>((resolve) => {
      this.map.set(id, { action, resolve, delivered: false });
    });
  }

  /**
   * Return every action the host hasn't been handed yet, marking them
   * delivered. The poller is expected to execute them and POST back to
   * `/bridge/action-result`. Re-delivery on poller retry isn't needed —
   * the queue holds the Promise until `resolve` is called.
   *
   * Actions older than `maxAgeMs` expire here: their `resolve` is called
   * with an `exitCode: 124, stderr: 'expired'` result so the in-box RPC
   * unblocks, and they don't appear in the drained list. Keeps a host
   * relay restart from replaying a long-forgotten `git.push`.
   */
  drain(): HostAction[] {
    const now = this.now();
    const out: HostAction[] = [];
    for (const [id, p] of this.map) {
      const createdAt = Date.parse(p.action.createdAt);
      if (Number.isFinite(createdAt) && now - createdAt > this.maxAgeMs) {
        this.map.delete(id);
        p.resolve({
          exitCode: 124,
          stdout: '',
          stderr: `host action '${p.action.method}' expired before the host could execute it\n`,
        });
        continue;
      }
      if (!p.delivered) {
        out.push(p.action);
        p.delivered = true;
      }
    }
    return out;
  }

  /**
   * Settle a parked action with the host's result. Idempotent: a duplicate
   * resolve on the same id is a no-op. Returns whether the id matched.
   */
  resolve(id: string, result: HostActionResult): boolean {
    const p = this.map.get(id);
    if (!p) return false;
    this.map.delete(id);
    p.resolve(result);
    return true;
  }

  size(): number {
    return this.map.size;
  }

  /** Test/diagnostic: get the action with this id (returns undefined when settled). */
  peek(id: string): HostAction | undefined {
    return this.map.get(id)?.action;
  }
}
