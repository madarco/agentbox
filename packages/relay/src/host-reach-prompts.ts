/**
 * Host-reach approvals in the hub (multi-PC Phase 4).
 *
 * A host-reach action runs on the PC that holds the files, so its confirm is
 * raised by that PC's relay — where only that PC's attach footer sees it. The
 * owner usually looks at the hub instead (web UI, tray, any CLI pointed at it),
 * so the PC also raises the prompt there: it lands in the hub's
 * `/api/v1/approvals`, answerable from any client, and the answer comes back
 * here to the PC that executes. The local footer keeps it too; whichever
 * answer comes first wins and the other copy is withdrawn.
 */
import type { PendingPrompts, PromptSubscribers } from './prompts.js';
import type { PromptAskEvent } from './types.js';

/** The PC's authenticated client for the hub's prompt routes. */
export interface HostReachPromptClient {
  /** Raise `prompt` for action `actionId`; null when the hub has no such route (older hub). */
  raise(actionId: string, prompt: Omit<PromptAskEvent, 'id'>): Promise<string | null>;
  /** Long-poll the hub prompt; `pending` after `waitMs` with no answer. */
  status(
    hubPromptId: string,
    waitMs: number,
  ): Promise<
    | { status: 'pending' }
    | { status: 'gone' }
    | { status: 'answered'; answer: 'y' | 'n'; cancelled?: boolean }
  >;
  /** Withdraw it (answered here first, or the action ended). */
  cancel(hubPromptId: string): Promise<void>;
}

const STATUS_WAIT_MS = 25_000;

/**
 * Mirror every prompt box `boxId` raises while action `actionId` runs. Returns
 * the unregister to call when the action is done.
 */
export function mirrorHostReachPrompts(deps: {
  prompts: PendingPrompts;
  subscribers: PromptSubscribers;
  boxId: string;
  actionId: string;
  client: HostReachPromptClient;
  log?: (line: string) => void;
}): () => void {
  const log = deps.log ?? ((): void => {});
  return deps.prompts.mirror(deps.boxId, (ev, answer, settled) => {
    let localDone = false;
    void settled.then(() => {
      localDone = true;
    });
    void (async () => {
      const { id: _id, ...prompt } = ev;
      void _id;
      let hubId: string | null;
      try {
        hubId = await deps.client.raise(deps.actionId, prompt);
      } catch (err) {
        log(
          `host-reach: could not raise the confirm on the hub (${err instanceof Error ? err.message : String(err)}); answer it here`,
        );
        return;
      }
      if (!hubId) return;
      const local = settled.then(() => 'local' as const);
      while (!localDone) {
        let st: Awaited<ReturnType<HostReachPromptClient['status']>> | 'local';
        try {
          // Raced with the local answer, so the hub copy comes down at once.
          st = await Promise.race([deps.client.status(hubId, STATUS_WAIT_MS), local]);
        } catch {
          // The hub blipped: the local copy still stands, so keep trying.
          await new Promise((r) => setTimeout(r, 2_000));
          continue;
        }
        if (st === 'local') break;
        if (st.status === 'gone') return;
        if (st.status === 'answered') {
          if (!localDone) {
            answer(st.answer, st.cancelled);
            deps.subscribers.broadcast(deps.boxId, 'prompt-resolved', { id: ev.id });
          }
          return;
        }
      }
      // Answered here first: take it down from the hub's approvals.
      await deps.client.cancel(hubId).catch(() => {});
    })();
  });
}
