import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { PromptAnswerBody, PromptAskEvent } from './types.js';

/**
 * Resolution shape passed back through `askPrompt`'s Promise. Mirrors the
 * shape the wrapper POSTs to `/admin/prompts/answer` minus the id (the
 * caller already knows it).
 */
export interface PromptResolution {
  answer: 'y' | 'n';
  cancelled?: boolean;
}

interface PendingPromptEntry {
  ev: PromptAskEvent;
  boxId: string;
  resolve: (r: PromptResolution) => void;
  createdAt: string;
}

/**
 * In-memory pending prompts map. The relay's host-action handlers (git push,
 * cp.*, download.*) put a pending entry here and await the Promise; the
 * wrapper's POST to `/admin/prompts/answer` resolves it. Entries live for
 * however long the user takes — per the design we block indefinitely until
 * a wrapper attaches and answers.
 */
/**
 * Per-box auto-approve policy, wired by the relay server once the registry +
 * event buffer are available. `shouldAutoApprove` reflects the box's
 * `autoApproveHostActions` registration flag; `audit` records the bypass to
 * the relay event ring buffer so it stays observable. Lives on
 * {@link PendingPrompts} because that instance is already threaded into every
 * `askPrompt` call site (host + cloud), so no handler signatures change.
 */
export interface AutoApprovePolicy {
  shouldAutoApprove(boxId: string): boolean;
  audit(boxId: string, params: Omit<PromptAskEvent, 'id'>, reason?: string): void;
}

/** A pending approval, flattened for listing across all boxes (hub UI). */
export interface PendingApproval {
  id: string;
  boxId: string;
  ev: PromptAskEvent;
  createdAt: string;
}

export class PendingPrompts {
  private readonly entries = new Map<string, PendingPromptEntry>();
  private autoApprove: AutoApprovePolicy | null = null;
  private onChange: (() => void) | null = null;

  /** Install the per-box auto-approve policy (relay server, once at startup). */
  setAutoApprovePolicy(policy: AutoApprovePolicy): void {
    this.autoApprove = policy;
  }

  /**
   * Install a change hook fired whenever the pending set is mutated (add /
   * resolve). Wired by the relay server to the hub notifier so the embedded UI
   * pushes an update to connected browsers.
   */
  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  /**
   * True when this box opted into `box.autoApproveHostActions`. Records the
   * bypass to the audit sink as a side effect so the caller short-circuits
   * with a trail. Returns false when no policy is installed.
   */
  consumeAutoApprove(boxId: string, params: Omit<PromptAskEvent, 'id'>): boolean {
    if (!this.autoApprove || !this.autoApprove.shouldAutoApprove(boxId)) return false;
    this.autoApprove.audit(boxId, params);
    return true;
  }

  /**
   * Record a *safe-subset* auto-approval (opening a PR, a contained file copy,
   * a sanctioned-branch push, …) to the audit sink WITHOUT the blanket
   * `autoApproveHostActions` opt-in. The handler already decided the action is
   * safe under `box.autoApproveSafeHostActions`; this just leaves the same
   * `host-action-auto-approved` trail a full opt-in would, tagged with `reason`.
   * No-op when no policy is installed (e.g. the stateless poll plane).
   */
  noteAutoApprove(boxId: string, params: Omit<PromptAskEvent, 'id'>, reason: string): void {
    this.autoApprove?.audit(boxId, params, reason);
  }

  add(boxId: string, ev: PromptAskEvent): Promise<PromptResolution> {
    return new Promise<PromptResolution>((resolve) => {
      this.entries.set(ev.id, {
        ev,
        boxId,
        resolve,
        createdAt: new Date().toISOString(),
      });
      this.onChange?.();
    });
  }

  /**
   * Idempotent: returns true if a pending entry was found + resolved, false
   * otherwise. The /admin/prompts/answer handler uses the bool to decide
   * 204 vs 404 — the wrapper treats both as "we're done."
   */
  resolve(id: string, answer: 'y' | 'n', cancelled?: boolean): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    entry.resolve({ answer, cancelled });
    this.onChange?.();
    return true;
  }

  /**
   * Snapshot of all pending prompts for a given box; used to flush the
   * backlog to a newly-attached SSE subscriber.
   */
  forBox(boxId: string): PromptAskEvent[] {
    const out: PromptAskEvent[] = [];
    for (const entry of this.entries.values()) {
      if (entry.boxId === boxId) out.push(entry.ev);
    }
    return out;
  }

  /**
   * Snapshot of every pending prompt across all boxes, with its boxId and
   * enqueue time — the hub's Approvals view lists these.
   */
  all(): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const entry of this.entries.values()) {
      out.push({ id: entry.ev.id, boxId: entry.boxId, ev: entry.ev, createdAt: entry.createdAt });
    }
    return out;
  }

  /** boxId that owns a pending prompt id, or null when unknown. */
  boxFor(id: string): string | null {
    const entry = this.entries.get(id);
    return entry ? entry.boxId : null;
  }

  size(): number {
    return this.entries.size;
  }
}

/** A callback subscriber to a box's prompt/notice broadcasts. */
export type PromptListener = (event: string, data: unknown) => void;

/**
 * Tracks the set of host-side wrappers currently subscribed per box. Two kinds
 * of subscriber exist:
 *   - raw `ServerResponse` SSE writers — the relay's own `/admin/prompts/stream`
 *     route (in-process on the same server).
 *   - callback `PromptListener`s — the hub's `/api/v1` prompt stream, which is a
 *     Next route that can't hold the relay's `ServerResponse` directly and
 *     receives the same events via a callback instead.
 *
 * `broadcast` writes to both so the user can answer from whichever attached
 * window (footer or web-driven stream) they happen to be in.
 */
export class PromptSubscribers {
  private readonly byBox = new Map<string, Set<ServerResponse>>();
  private readonly listenersByBox = new Map<string, Set<PromptListener>>();
  private durableFloor = 0;

  add(boxId: string, res: ServerResponse): void {
    let set = this.byBox.get(boxId);
    if (!set) {
      set = new Set();
      this.byBox.set(boxId, set);
    }
    set.add(res);
  }

  remove(boxId: string, res: ServerResponse): void {
    const set = this.byBox.get(boxId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.byBox.delete(boxId);
  }

  /**
   * Register a callback subscriber for a box; returns an unsubscribe. Used by
   * the hub's `/api/v1` prompt-stream route (a Next route, reached via a
   * globalThis seam) so its stream gets the same `prompt-ask`/`prompt-resolved`/
   * `notice-*` events the footer's admin stream does.
   */
  addListener(boxId: string, fn: PromptListener): () => void {
    let set = this.listenersByBox.get(boxId);
    if (!set) {
      set = new Set();
      this.listenersByBox.set(boxId, set);
    }
    set.add(fn);
    return () => {
      const s = this.listenersByBox.get(boxId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.listenersByBox.delete(boxId);
    };
  }

  forBox(boxId: string): ServerResponse[] {
    const set = this.byBox.get(boxId);
    return set ? Array.from(set) : [];
  }

  /**
   * Set a process-wide floor added to every box's {@link count}. This is how the
   * always-on hub declares itself the *durable subscriber*: when the floor is 1,
   * a pending prompt is always answerable (the web UI + `/api/v1/approvals/:id/
   * answer` never go away), so a host-action gate (e.g. git.push) parks the
   * prompt instead of auto-denying when no wrapper is attached. Gated to the
   * control-box profile by the caller — a plain local hub keeps floor 0 (the
   * user is present; an unattended local box shouldn't wedge on a blocked push).
   */
  setDurableFloor(n: number): void {
    this.durableFloor = Math.max(0, n);
  }

  /**
   * How many subscribers a box has: raw SSE writers + callback listeners + the
   * durable floor. The host-action no-subscriber gate reads this to decide
   * whether a confirm can be surfaced-and-answered (park) or must fall back to
   * its `*_NO_SUB` policy (auto-deny by default). Counting listeners is
   * load-bearing: the footer moved from a `ServerResponse` on `/admin/prompts/
   * stream` to a callback on the `/api/v1` stream, so a `forBox().length` check
   * would no longer see an attached footer and would silently auto-deny.
   */
  count(boxId: string): number {
    const responses = this.byBox.get(boxId)?.size ?? 0;
    const listeners = this.listenersByBox.get(boxId)?.size ?? 0;
    return responses + listeners + this.durableFloor;
  }

  /**
   * Fire-and-forget broadcast to both SSE writers and callback listeners. Writes
   * that fail (closed socket) are swallowed — the route's `close` handler already
   * deregisters the dead subscriber; a throwing listener is isolated the same way.
   */
  broadcast(boxId: string, event: string, data: unknown): void {
    const set = this.byBox.get(boxId);
    if (set) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of set) {
        try {
          res.write(payload);
        } catch {
          /* dead socket; close handler will deregister */
        }
      }
    }
    const listeners = this.listenersByBox.get(boxId);
    if (listeners) {
      for (const fn of listeners) {
        try {
          fn(event, data);
        } catch {
          /* an errant listener must not take the broadcast (or its peers) down */
        }
      }
    }
  }
}

/**
 * Internal API used by handleGitRpc / handleCpRpc / handleDownloadRpc and the
 * `browser.open` host-mirror offer. Generates a UUID, adds a pending entry,
 * broadcasts the SSE event, and awaits the answer. Respects
 * `process.env.AGENTBOX_PROMPT === 'off'` — auto-accepts without broadcasting
 * (useful for headless scripts and tests) — and the per-box
 * `box.autoApproveHostActions` policy (auto-accepts with an audit event).
 *
 * `opts.ttlMs` makes the prompt auto-expire: if no answer arrives in time it
 * resolves to its `defaultAnswer` (cancelled) and a `prompt-resolved` event is
 * broadcast so attached wrappers clear it. Used for optional, non-blocking
 * prompts that must not linger when nobody answers; omit it for the
 * block-until-answered prompts that gate a paused in-box RPC.
 */
export async function askPrompt(
  prompts: PendingPrompts,
  subscribers: PromptSubscribers,
  boxId: string,
  params: Omit<PromptAskEvent, 'id'>,
  opts?: { ttlMs?: number },
): Promise<PromptResolution> {
  if (process.env.AGENTBOX_PROMPT === 'off') {
    return { answer: 'y' };
  }
  // Per-box opt-in: `box.autoApproveHostActions` resolves the confirm to 'y'
  // without surfacing a prompt, but records an audit event (inside
  // consumeAutoApprove) so the bypass is never silent.
  if (prompts.consumeAutoApprove(boxId, params)) {
    return { answer: 'y' };
  }
  const ev: PromptAskEvent = { id: randomUUID(), ...params };
  const promise = prompts.add(boxId, ev);
  subscribers.broadcast(boxId, 'prompt-ask', ev);
  if (opts?.ttlMs !== undefined && opts.ttlMs > 0) {
    const timer = setTimeout(() => {
      if (prompts.resolve(ev.id, params.defaultAnswer ?? 'n', true)) {
        subscribers.broadcast(boxId, 'prompt-resolved', { id: ev.id });
      }
    }, opts.ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    void promise.then(() => {
      clearTimeout(timer);
    });
  }
  return promise;
}

/** Helper for the answer body — used by the relay server to validate. */
export function isPromptAnswerBody(v: unknown): v is PromptAnswerBody {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return false;
  if (o.answer !== 'y' && o.answer !== 'n') return false;
  if (o.cancelled !== undefined && typeof o.cancelled !== 'boolean') return false;
  return true;
}
