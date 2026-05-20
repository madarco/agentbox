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
export class PendingPrompts {
  private readonly entries = new Map<string, PendingPromptEntry>();

  add(boxId: string, ev: PromptAskEvent): Promise<PromptResolution> {
    return new Promise<PromptResolution>((resolve) => {
      this.entries.set(ev.id, {
        ev,
        boxId,
        resolve,
        createdAt: new Date().toISOString(),
      });
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
 * Internal API used by handleGitRpc / handleCpRpc / handleDownloadRpc.
 * Generates a UUID, adds a pending entry, broadcasts the SSE event, and
 * awaits the answer. Respects `process.env.AGENTBOX_PROMPT === 'off'` —
 * auto-accepts without broadcasting (useful for headless scripts and tests).
 */
export async function askPrompt(
  prompts: PendingPrompts,
  subscribers: PromptSubscribers,
  boxId: string,
  params: Omit<PromptAskEvent, 'id'>,
): Promise<PromptResolution> {
  if (process.env.AGENTBOX_PROMPT === 'off') {
    return { answer: 'y' };
  }
  const ev: PromptAskEvent = { id: randomUUID(), ...params };
  const promise = prompts.add(boxId, ev);
  subscribers.broadcast(boxId, 'prompt-ask', ev);
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
