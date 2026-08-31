/**
 * Codex as a package.
 *
 * Everything Codex-specific about running it in a docker box lives here, and
 * `sandbox-docker` no longer imports any of it — it receives `codexSyncModule`
 * through the `AgentSyncModule` registry. That inversion is what lets an agent
 * be a package at all: an agent's behavior depends on `sandbox-docker`, so
 * `sandbox-docker` importing it back is a dependency cycle turbo refuses.
 *
 * The CLI re-exports what it needs from here; nothing below this package does.
 */

import { registerAgentSyncModule, type AgentSyncModule } from '@agentbox/sandbox-docker';
import {
  buildCodexMounts,
  codexSessionInfo,
  ensureCodexVolume,
  resolveCodexVolume,
  seedCodexAgentsOverride,
} from './docker-sync.js';

/** Codex's docker behavior, in the shape `sandbox-docker` asks for. */
export const codexSyncModule: AgentSyncModule = {
  id: 'codex',
  resolveVolume: (opts) => resolveCodexVolume(opts),
  buildMounts: (spec, env) => buildCodexMounts(spec, env),
  ensureVolume: async (spec, opts) => ensureCodexVolume(spec, opts),
  sessionInfo: (container) => codexSessionInfo(container),
  // The AGENTS.override.md box-facts fold. It used to be called by name from
  // `docker-sync.ts`; it is Codex's own post-sync step now.
  afterVolumeSync: async (volume, image) => {
    const r = await seedCodexAgentsOverride(volume, image);
    return { notes: r.seeded ? ['seeded AGENTS.override.md with box facts'] : [] };
  },
};

/** Register Codex. Called by `@agentbox/agent-modules`, never by a lower layer. */
export function registerCodexAgent(): void {
  registerAgentSyncModule(codexSyncModule);
}

// The CLI still reaches for these by name; they move behind the module contract
// as the remaining phases convert their call sites.
export * from './docker-sync.js';
