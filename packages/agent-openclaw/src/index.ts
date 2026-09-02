/**
 * OpenClaw as a package — the first SERVICE agent.
 *
 * Smaller than every TUI agent's package, and the difference is the point: a
 * service agent has no `src/cli/`. `buildAgentCommand`'s contract
 * (`AgentRuntime`) requires a `startSession` that makes a tmux session, a
 * `buildAttachArgv`, a login flow and a resume probe, none of which a daemon
 * can satisfy. Its CLI comes from the shared service factory instead
 * (`apps/cli/src/agents/command/service-factory.ts`), built off the registry
 * row, so there is nothing tool-specific to write.
 *
 * What is left is the docker half: which volume the box mounts and where.
 */

import { registerAgentSyncModule, type AgentSyncModule } from '@agentbox/sandbox-docker';
import {
  buildOpenclawMounts,
  ensureOpenclawVolume,
  openclawSessionInfo,
  resolveOpenclawVolume,
} from './docker-sync.js';

export const openclawSyncModule: AgentSyncModule = {
  id: 'openclaw',
  resolveVolume: (opts) => resolveOpenclawVolume(opts),
  buildMounts: (spec) => buildOpenclawMounts(spec),
  ensureVolume: async (spec, opts) => ensureOpenclawVolume(spec, { image: opts.image }),
  sessionInfo: () => Promise.resolve(openclawSessionInfo()),
};

/** Register OpenClaw's docker behavior. Called by `@agentbox/agent-modules`. */
export function registerOpenclawAgent(): void {
  registerAgentSyncModule(openclawSyncModule);
}

export * from './docker-sync.js';
