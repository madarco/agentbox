import { randomUUID } from 'node:crypto';
import { askPrompt, type PendingPrompts, type PromptSubscribers } from './prompts.js';
import type { Store } from './store/store.js';
import type { PromptAskEvent } from './types.js';

/**
 * How the relay obtains host-action approval:
 *   - 'block' — the laptop loopback relay (a long-lived process): the `/rpc`
 *     handler blocks on an in-process `PendingPrompts` Promise until the human
 *     answers (today's behavior, unchanged).
 *   - 'poll'  — the hosted control plane (serverless / stateless per request):
 *     the gate parks a prompt row in the Store and returns immediately; `/rpc`
 *     replies `202 {promptId}` and the box polls `/rpc/status/:id` for the
 *     verdict + result.
 */
export type PromptMode = 'block' | 'poll';

export type ApprovalGate =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'pending'; promptId: string };

export interface GateDeps {
  mode: PromptMode;
  store: Store;
  /** Required for block mode (the in-process blocking wait). */
  prompts?: PendingPrompts;
  /** Optional: SSE fan-out to an attached human dashboard. Absent on the stateless plane. */
  subscribers?: PromptSubscribers;
}

/**
 * Decide whether a host action may proceed. The caller has already cleared the
 * fast paths that never prompt at all (agentbox/* branch, valid host-initiated
 * token, read-only op). `promptParams` is the confirm to show the human;
 * `method`/`params` are persisted on the poll-mode row so the approved action
 * can be re-dispatched when the box polls.
 *
 * - 'block': returns allow/deny once the human answers (or AGENTBOX_PROMPT=off
 *   / autoApprove resolves it). Behaviorally identical to the pre-poll relay.
 * - 'poll': returns allow when no human is needed (AGENTBOX_PROMPT=off /
 *   autoApprove, audited), else parks a pending row and returns its promptId.
 */
export async function gateApproval(
  deps: GateDeps,
  boxId: string,
  method: string,
  params: unknown,
  promptParams: Omit<PromptAskEvent, 'id'>,
): Promise<ApprovalGate> {
  if (deps.mode === 'block') {
    // askPrompt handles AGENTBOX_PROMPT=off + autoApprove (with audit) + the
    // blocking wait, exactly as before. Block mode requires in-process state.
    if (!deps.prompts || !deps.subscribers) return { kind: 'deny' };
    const verdict = await askPrompt(deps.prompts, deps.subscribers, boxId, promptParams);
    return verdict.answer === 'y' && !verdict.cancelled ? { kind: 'allow' } : { kind: 'deny' };
  }
  // poll mode: store-based fast paths (works on the stateless hosted plane, no
  // in-process registry/prompts), then park a row the box will poll for.
  if (process.env.AGENTBOX_PROMPT === 'off') return { kind: 'allow' };
  const box = await deps.store.getBox(boxId);
  if (box?.autoApproveHostActions) {
    // Audited bypass — still observable in the event feed.
    await deps.store.appendEvent({
      boxId,
      type: 'host-action-auto-approved',
      payload: {
        command: promptParams.context?.command,
        argv: promptParams.context?.argv,
        message: promptParams.message,
      },
    });
    return { kind: 'allow' };
  }
  const promptId = randomUUID();
  const ev: PromptAskEvent = { id: promptId, ...promptParams };
  await deps.store.createPrompt({
    id: promptId,
    boxId,
    ev,
    method,
    params,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  // Best-effort SSE for an attached human dashboard (no-op when none / on the
  // stateless plane); the box itself never relies on SSE — it polls /rpc/status.
  deps.subscribers?.broadcast(boxId, 'prompt-ask', ev);
  return { kind: 'pending', promptId };
}
