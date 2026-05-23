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

export class HostActionQueue {
  private readonly map = new Map<string, Pending>();

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
      createdAt: new Date().toISOString(),
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
   */
  drain(): HostAction[] {
    const out: HostAction[] = [];
    for (const p of this.map.values()) {
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
