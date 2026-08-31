/**
 * The per-agent module table — the CLI-side behavior tier above the sync
 * registry.
 *
 * `AGENT_SYNC_SPECS` (`@agentbox/sandbox-core`) holds everything about an agent
 * that is DATA: paths, credential locations, install recipes, capabilities. It
 * has to stay JSON-serializable, because a projection of it is shipped into a
 * box whose `agentbox-ctl` was baked before that agent existed. Anything
 * function-valued therefore cannot live there — a login prompt detector and a
 * session-teleport resolver are code. This table is where that code hangs, one
 * folder per agent, so adding an agent is adding a folder rather than editing
 * every consumer.
 *
 * The `import()` specifiers are LITERAL — one arm per agent — for the same
 * reason `provider/loaders.ts` keeps its provider map literal: the CLI's tsup
 * build has to statically resolve each specifier, and a computed
 * `import('./agents/' + id + '/index.js')` would not be bundled and would
 * `MODULE_NOT_FOUND` in the published CLI (never in the dev tree, which is what
 * makes that failure so easy to ship).
 *
 * Lazy, so the table costs nothing on a path that does not use it: `agentbox
 * --help` must not pull three agent modules and their transitive deps into
 * startup.
 *
 * NOT exhaustive by type. `AgentId` is an open string, so the compiler cannot
 * prove this map covers the registry — `agent-module-table.test.ts` asserts its
 * keys against `agentIds()` instead. That test is load-bearing; without it a new
 * registry row silently has no module.
 */

import type { AgentId } from '@agentbox/core';
import { defineAgentModule, type AgentModule, type TeleportResolver } from '@agentbox/cli-kit';

// Re-exported: ~4 call sites reach for these through this barrel, and the
// contract's new home is an implementation detail to them.
export { defineAgentModule, type AgentModule, type TeleportResolver };

const AGENT_MODULES: Record<string, () => Promise<{ agentModule: AgentModule }>> = {
  claude: () => import('@agentbox/agent-claude/cli'),
  codex: () => import('@agentbox/agent-codex/cli'),
  opencode: () => import('@agentbox/agent-opencode/cli'),
  example: () => import('@agentbox/agent-example/cli'),
};

/** Agent ids with a module in this build. */
export function agentModuleIds(): string[] {
  return Object.keys(AGENT_MODULES);
}

/**
 * Load one agent's module. Throws with the agent named rather than returning
 * undefined: every caller needs the module to proceed, and a silent `undefined`
 * surfaces later as an unattributable TypeError.
 */
export async function loadAgentModule(id: AgentId): Promise<AgentModule> {
  const importer = AGENT_MODULES[id];
  if (!importer) {
    // `resolveAgentSpec` throwing first would be the commoner case; reaching
    // here means the registry knows the agent but this table does not.
    throw new Error(
      `no agent module for '${id}' — it is missing an entry in apps/cli/src/agents/index.ts`,
    );
  }
  return (await importer()).agentModule;
}

