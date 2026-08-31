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

import { resolveAgentSpec } from '@agentbox/sandbox-core';
import {
  extractCodexCredentials,
  registerAgentSyncModule,
  type AgentSyncModule,
} from '@agentbox/sandbox-docker';
import { registerAgentCloudModule, type AgentCloudModule } from '@agentbox/sandbox-cloud';
import { ensureCodexAgentsOverride } from './cloud-sync.js';
import { stageCodexCredentialsForUpload, stageCodexStaticForUpload } from './host-stage.js';
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
  // Extract-only: unlike claude there is no docker bind mount of the host's real
  // ~/.codex into the box, and codex's auth.json carries no expiry field to gate
  // on — so always try, and let the helper report no-op when there is no volume.
  refreshHostBackup: async (image) => {
    await extractCodexCredentials(resolveAgentSpec('codex').dockerVolume, image);
  },
  afterVolumeSync: async (volume, image) => {
    const r = await seedCodexAgentsOverride(volume, image);
    return { notes: r.seeded ? ['seeded AGENTS.override.md with box facts'] : [] };
  },
};

/** Codex's cloud behavior — the same box-facts fold, for a box with no volume. */
export const codexCloudModule: AgentCloudModule = {
  id: 'codex',
  afterSeed: (backend, handle, opts) => ensureCodexAgentsOverride(backend, handle, opts),
  // Codex's staging is more than a copy of its declared paths — it sanitizes
  // config.toml's host-only entries and purges orphan marketplace caches — so
  // it supplies its own rather than riding the generic stager.
  stageStatic: () => stageCodexStaticForUpload(),
  stageCredentials: () => stageCodexCredentialsForUpload(),
};

/** Register Codex on both layers. Called by `@agentbox/agent-modules`. */
export function registerCodexAgent(): void {
  registerAgentSyncModule(codexSyncModule);
  registerAgentCloudModule(codexCloudModule);
}

// The CLI still reaches for these by name; they move behind the module contract
// as the remaining phases convert their call sites.
export { ensureCodexAgentsOverride } from './cloud-sync.js';
export * from './docker-sync.js';
export * from './host-stage.js';
export * from './box-config.js';

export { codexStagedItems } from './staged-items.js';
