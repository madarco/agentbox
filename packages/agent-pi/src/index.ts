/**
 * Pi as a package. Same shape as `@agentbox/agent-opencode`: everything
 * Pi-specific about running it in a box lives here, and `sandbox-docker` /
 * `sandbox-cloud` receive it through their module registries rather than
 * importing it.
 */

import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { requireAgentCredential } from '@agentbox/core';
import {
  extractVolumeAuthToBackup,
  registerAgentSyncModule,
  type AgentSyncModule,
} from '@agentbox/sandbox-docker';
import { registerAgentCloudModule, type AgentCloudModule } from '@agentbox/sandbox-cloud';
import { stagePiCredentialsForUpload } from './host-stage.js';
import { buildPiMounts, ensurePiVolume, piSessionInfo, resolvePiVolume } from './docker-sync.js';

/** Pi's docker behavior. No post-sync hook and no expiring credential. */
export const piSyncModule: AgentSyncModule = {
  id: 'pi',
  resolveVolume: (opts) => resolvePiVolume(opts),
  buildMounts: (spec, env) => buildPiMounts(spec, env),
  ensureVolume: async (spec, opts) => ensurePiVolume(spec, opts),
  sessionInfo: (container) => piSessionInfo(container),
  // Extract-only, same as codex/opencode: no host bind mount and no expiry
  // field, so the helper runs unconditionally and reports nothing copied when
  // there is no volume to read.
  refreshHostBackup: async (image) => {
    // The GENERIC helper plus the registry's own paths, not a `extractPi…`
    // wrapper: there is nothing Pi-specific about copying `auth.json` out of a
    // volume, and a per-agent function is exactly the coupling the sync
    // registry exists to remove.
    const spec = resolveAgentSpec('pi');
    await extractVolumeAuthToBackup({
      volume: spec.dockerVolume,
      image,
      backupFile: requireAgentCredential(spec).hostBackup,
    });
  },
};

/**
 * Pi's cloud behavior: only the credential stager is its own. There is no
 * `afterSeed` — unlike OpenCode, Pi keeps no per-box state the host is
 * authoritative for (its model choice lives in the synced `settings.json`).
 */
export const piCloudModule: AgentCloudModule = {
  id: 'pi',
  stageCredentials: () => stagePiCredentialsForUpload(),
  // Required by the contract, and genuinely nothing to do: Pi's declared
  // `seeds` place the activity extension, its static config rides
  // `stageAllAgentStatic`, and it keeps no per-box state the host owns.
  afterSeed: () => Promise.resolve(),
};

/** Register Pi on both layers. Called by `@agentbox/agent-modules`. */
export function registerPiAgent(): void {
  registerAgentSyncModule(piSyncModule);
  registerAgentCloudModule(piCloudModule);
}

export * from './docker-sync.js';
export { stagePiCredentialsForUpload, stagePiStaticForUpload } from './host-stage.js';
export { piStagedItems } from './staged-items.js';
