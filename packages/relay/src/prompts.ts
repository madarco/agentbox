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

/**
 * Tracks the set of host-side wrappers (SSE clients) currently subscribed
 * per box. `broadcast` writes to every subscriber so the user can answer
 * from whichever attached window they happen to be in.
 */
export class PromptSubscribers {
  private readonly byBox = new Map<string, Set<ServerResponse>>();

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

  forBox(boxId: string): ServerResponse[] {
    const set = this.byBox.get(boxId);
    return set ? Array.from(set) : [];
  }

  /**
   * Fire-and-forget broadcast. SSE writes that fail (closed socket) are
   * swallowed — the `res.on('close')` handler in the server route already
   * deregisters the dead subscriber.
   */
  broadcast(boxId: string, event: string, data: unknown): void {
    const set = this.byBox.get(boxId);
    if (!set) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        /* dead socket; close handler will deregister */
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
