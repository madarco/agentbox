/**
 * The demo agent as a package.
 *
 * This is the reference for "an agent is a package": a spec row in
 * `@agentbox/agent-registry`, this package, and one arm in
 * `@agentbox/agent-modules`. Nothing else in the repo knows it exists.
 *
 * It stays `hidden` on its spec, so it is absent from pickers, `--help` and the
 * bake list while being fully real to the machinery — a canary rather than a
 * supported agent.
 */

import { registerAgentSyncModule, type AgentSyncModule } from '@agentbox/sandbox-docker';
import {
  buildExampleMounts,
  ensureExampleVolume,
  exampleSessionInfo,
  resolveExampleVolume,
} from './docker-sync.js';

/**
 * The smallest complete `AgentSyncModule`: the four required methods and
 * neither optional hook, because this agent has no post-sync step and no
 * credential that expires.
 */
export const exampleSyncModule: AgentSyncModule = {
  id: 'example',
  resolveVolume: (opts) => resolveExampleVolume(opts),
  buildMounts: (spec) => buildExampleMounts(spec),
  ensureVolume: async (spec, opts) => ensureExampleVolume(spec, { image: opts.image }),
  sessionInfo: (container) => exampleSessionInfo(container),
};

/** Register the demo agent. Called by `@agentbox/agent-modules`. */
export function registerExampleAgent(): void {
  registerAgentSyncModule(exampleSyncModule);
}

export * from './docker-sync.js';
