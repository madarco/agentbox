// Adding an agent to an existing box (`agentbox openclaw <box>`), on the hub
// that owns it.
//
// A service agent's units reach a box only through `agents.list`, which answers
// from the box's REGISTRATION on this hub. So the registration must name the
// agent, written by this hub with the box's own token: a PC re-registering the
// box itself writes the PC record's token, which is not the one in the box's
// relay.env, and every box->hub call then 401s ("unknown box token").
import type { BoxRecord } from '@agentbox/core';
import type { BoxRegistration } from '@agentbox/relay';

export interface BoxAgentDeps {
  /** This hub's record of the box, by id or name; null when it has none. */
  findBox(ref: string): Promise<BoxRecord | null>;
  /** Persist the agent on this hub's record (so a rehydrate re-registers it). */
  recordAgent(boxId: string, agent: string): Promise<BoxRecord | undefined>;
  getRegistration(boxId: string): Promise<BoxRegistration | undefined>;
  /** Replace the stored registration (the relay store's `registerBox`). */
  register(reg: BoxRegistration): Promise<void>;
  /** The canonical id of a known agent (by id or alias), or undefined. */
  agentId(name: string): string | undefined;
}

export type AddBoxAgentResult =
  | { kind: 'ok'; boxId: string; agents: string[] }
  | { kind: 'not_found' }
  | { kind: 'invalid'; error: string };

export async function addBoxAgent(
  deps: BoxAgentDeps,
  ref: string,
  name: string,
): Promise<AddBoxAgentResult> {
  const agent = name === 'none' ? undefined : deps.agentId(name);
  if (!agent) return { kind: 'invalid', error: `unknown agent: ${name}` };
  const box = await deps.findBox(ref);
  const boxId = box?.id ?? ref;
  const reg = await deps.getRegistration(boxId);
  if (!box && !reg) return { kind: 'not_found' };
  const recorded = box ? await deps.recordAgent(box.id, agent) : undefined;
  // One agent per registration: the one just added is the one whose units the
  // box needs now (a box running claude AND openclaw is a backlog item).
  if (reg && reg.agent !== agent) await deps.register({ ...reg, agent });
  const agents = recorded?.agents ?? (box?.agents ? [...box.agents] : [agent]);
  return { kind: 'ok', boxId, agents: agents.includes(agent) ? agents : [...agents, agent] };
}
