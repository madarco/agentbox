/**
 * OpenCode as a package. Same shape as `@agentbox/agent-codex`: everything
 * OpenCode-specific about running it in a docker box lives here, and
 * `sandbox-docker` receives it through the `AgentSyncModule` registry rather
 * than importing it.
 */

import { resolveAgentSpec } from '@agentbox/sandbox-core';
import {
  extractOpencodeCredentials,
  registerAgentSyncModule,
  type AgentSyncModule,
} from '@agentbox/sandbox-docker';
import { registerAgentCloudModule, type AgentCloudModule } from '@agentbox/sandbox-cloud';
import { seedOpencodeModelState } from './cloud-sync.js';
import { stageOpencodeCredentialsForUpload } from './host-stage.js';
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
  // Extract-only, same as codex: no host bind mount and no expiry field, so the
  // helper is called unconditionally and reports { copied: false } if there is
  // no volume to read.
  refreshHostBackup: async (image) => {
    await extractOpencodeCredentials(resolveAgentSpec('opencode').dockerVolume, image);
  },
};

/**
 * OpenCode's cloud behavior: seed the host's selected model. A cloud box's state
 * dir is ephemeral, so the host is authoritative on every create.
 */
export const opencodeCloudModule: AgentCloudModule = {
  id: 'opencode',
  afterSeed: (backend, handle, opts) => seedOpencodeModelState(backend, handle, opts),
  // Static staging rides the generic registry-driven stager — OpenCode's
  // multi-source layout is entirely `staticPaths` data. Only the credential
  // stager is its own.
  stageCredentials: () => stageOpencodeCredentialsForUpload(),
};

/** Register OpenCode on both layers. Called by `@agentbox/agent-modules`. */
export function registerOpencodeAgent(): void {
  registerAgentSyncModule(opencodeSyncModule);
  registerAgentCloudModule(opencodeCloudModule);
}

export { seedOpencodeModelState } from './cloud-sync.js';
export * from './docker-sync.js';

export { opencodeStagedItems } from './staged-items.js';
