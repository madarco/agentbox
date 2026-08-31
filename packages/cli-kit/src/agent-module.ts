/**
 * The CLI-side module an agent supplies: its login detector, its runtime
 * bindings, and its optional teleport resolver.
 *
 * Split from `apps/cli/src/agents/index.ts` for one reason — an agent PACKAGE
 * has to be able to build one of these, and a package cannot import the app.
 * The literal-import TABLE that loads them stays in the CLI, because its
 * specifiers must be statically resolvable by the CLI's own bundle.
 */

import type { AgentId } from '@agentbox/core';
import { resolveAgentSpec, type AgentSyncSpec } from '@agentbox/sandbox-core';
import type { AgentLoginSpec } from './agent-login-specs.js';
import type { AgentRuntime } from './agent-contract.js';
import type { ResolvedTeleport, ResumeMode, TeleportLogger } from './teleport-types.js';

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

/**
 * Build an agent's CLI module, taking its registry row BY REFERENCE.
 *
 * Never a copy: `agent-module-table.test.ts` asserts `mod.spec` is identical to
 * `resolveAgentSpec(id)`, so a divergent copy fails rather than drifting.
 */
export function defineAgentModule(
  id: AgentId,
  parts: Omit<AgentModule, 'id' | 'spec'>,
): AgentModule {
  return { id, spec: resolveAgentSpec(id), ...parts };
}
