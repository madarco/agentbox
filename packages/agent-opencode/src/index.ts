/**
 * OpenCode as a package. Same shape as `@agentbox/agent-codex`: everything
 * OpenCode-specific about running it in a docker box lives here, and
 * `sandbox-docker` receives it through the `AgentSyncModule` registry rather
 * than importing it.
 */

import { registerAgentSyncModule, type AgentSyncModule } from '@agentbox/sandbox-docker';
import {
  buildOpencodeMounts,
  ensureOpencodeVolume,
  opencodeSessionInfo,
  resolveOpencodeVolume,
} from './docker-sync.js';

/** OpenCode's docker behavior. No post-sync hook and no expiring credential. */
export const opencodeSyncModule: AgentSyncModule = {
  id: 'opencode',
  resolveVolume: (opts) => resolveOpencodeVolume(opts),
  buildMounts: (spec, env) => buildOpencodeMounts(spec, env),
  ensureVolume: async (spec, opts) => ensureOpencodeVolume(spec, opts),
  sessionInfo: (container) => opencodeSessionInfo(container),
};

/** Register OpenCode. Called by `@agentbox/agent-modules`. */
export function registerOpencodeAgent(): void {
  registerAgentSyncModule(opencodeSyncModule);
}

export * from './docker-sync.js';
