// Resolve a control-plane create job's `agent` to a registry row.
//
// Kept pure (no fs, no store, no provider import) so it is testable, the same
// reason `control-plane-create.ts` is.
import { isServiceAgent, type AgentSyncSpec } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';

/**
 * The registry row for a create job's agent, or undefined when the job asks for
 * no agent at all.
 *
 * FAIL-CLOSED. This used to narrow to four hardcoded ids and DROP anything
 * else — so a repo-based create for `openclaw` (or any `agentbox agent add`
 * plugin agent) built a box that registered with no agent and started nothing.
 * A silent no-op is worse than a failed job: the user gets a box that looks
 * fine and does none of what they asked for. Unknown now throws, and the job
 * fails with the agent named.
 */
export function resolveCreateAgentSpec(agent: string | undefined): AgentSyncSpec | undefined {
  if (!agent || agent === 'none') return undefined;
  return resolveAgentSpec(agent);
}

/**
 * Does this create need an agent SESSION started in the box after it is built?
 *
 * No for a service agent: it is a daemon ctl's supervisor runs from the units
 * it synthesizes in-box, so there is no tmux session to pre-start and its
 * binary would not answer to one.
 */
export function createStartsSession(spec: AgentSyncSpec | undefined): boolean {
  return spec !== undefined && !isServiceAgent(spec);
}
