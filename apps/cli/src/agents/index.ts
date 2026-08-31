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
import { resolveAgentSpec, type AgentSyncSpec } from '@agentbox/sandbox-core';
import type { AgentLoginSpec } from '@agentbox/cli-kit';
import type { AgentRuntime } from '@agentbox/cli-kit';
import type { ResolvedTeleport, ResumeMode, TeleportLogger } from '@agentbox/cli-kit';

/** Host-side session resolve for one agent — see `session-teleport/index.ts`. */
export type TeleportResolver = (input: {
  hostCwd: string;
  mode: ResumeMode;
  log?: TeleportLogger;
}) => Promise<ResolvedTeleport>;

export interface AgentModule {
  id: AgentId;
  /** The registry row, by reference. Never a copy — one source of truth. */
  spec: AgentSyncSpec;
  /** Guided-login prompt detector. */
  login: AgentLoginSpec;
  /**
   * Docker bindings and the agent's own login code — everything the CLI needs
   * that is not the commander tree. Kept here rather than on the command table
   * so a caller that only wants to restart a session (`agent-sessions.ts`) does
   * not pull three commanders' worth of imports to do it.
   */
  runtime: AgentRuntime;
  /**
   * Host session teleport. Absent exactly when the spec declares
   * `caps.teleport: 'stub'`; `prepareTeleport` refuses on the capability before
   * it ever looks here, so the two can never disagree silently.
   */
  teleport?: TeleportResolver;
}

const AGENT_MODULES: Record<string, () => Promise<{ agentModule: AgentModule }>> = {
  claude: () => import('./claude/index.js'),
  codex: () => import('./codex/index.js'),
  opencode: () => import('./opencode/index.js'),
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

/** Shared by the agent module files: pull the spec, keep the wiring in one place. */
export function defineAgentModule(
  id: AgentId,
  parts: Omit<AgentModule, 'id' | 'spec'>,
): AgentModule {
  return { id, spec: resolveAgentSpec(id), ...parts };
}
