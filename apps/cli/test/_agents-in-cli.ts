import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import type { AgentSyncSpec } from '@agentbox/core';

/**
 * The agents the CLI's hand-maintained tables are currently expected to cover.
 *
 * **This filter is a running count of how far "an agent is a package" actually
 * goes, and it is meant to disappear.**
 *
 * `@agentbox/agent-example` is a real registry row with no CLI wiring — the
 * canary. Every table that still has to be edited by hand to support a new agent
 * fails while it is present, which is the honest measure of what adding an agent
 * costs. The tables below opt out for now, each for a reason that a named phase
 * removes:
 *
 *  - `AGENT_MODULES` / `agents/commands.ts` — the module and command tables
 *    still live in `apps/cli/src/agents/`; they move into the agent packages,
 *    at which point the example supplies its own and the filter goes.
 *  - resume probes + session-name resolution — read `AgentRuntime`, which is
 *    part of the same move.
 *
 * When this file has no callers left, adding an agent costs its own package and
 * one literal-import arm, and that claim is a test result rather than a promise.
 */
export function agentsWiredIntoCli(): AgentSyncSpec[] {
  return AGENT_SYNC_SPECS.filter((s) => !s.hidden);
}

/** Ids of {@link agentsWiredIntoCli}. */
export function agentIdsWiredIntoCli(): string[] {
  return agentsWiredIntoCli().map((s) => s.id);
}
