/**
 * The Vercel Sandbox provider. A thin `CloudBackend` over `@vercel/sandbox`,
 * composed via `@agentbox/sandbox-cloud`'s `createCloudProvider` for everything
 * provider-agnostic (workspace seeding, ctl/VNC launch, state, relay polling).
 *
 * Three capabilities are overridden on top of the cloud scaffold:
 *   - `prepare`     — bake the base snapshot (Vercel can't build from a Dockerfile).
 *   - `buildAttach` — SDK-streaming tmux bridge (Vercel has no SSH).
 *   - `checkpoint`  — store the Vercel snapshot *id* in the manifest so restore
 *     boots from it (Vercel snapshots are id-addressed, not name-addressed).
 *
 * `launchDockerd: false` because Vercel Sandbox can't run nested containers.
 */

import type { BoxRecord, Provider, ProviderCheckpoint } from '@agentbox/core';
import {
  createCloudProvider,
  currentCloudBaseFingerprint,
  listCloudCheckpoints,
  removeCloudCheckpointDir,
  resolveCloudCheckpoint,
  writeCloudCheckpointManifest,
} from '@agentbox/sandbox-cloud';
import {
  vercelBackend,
  snapshotVercelSandbox,
  deleteVercelSnapshot,
  DEFAULT_BOX_IMAGE_REF,
} from './backend.js';
import { readCliStamp, recordBox } from '@agentbox/sandbox-core';
import { prepareVercelProvider } from './prepare.js';
import { buildVercelAttach } from './build-attach.js';

const BACKEND_NAME = 'vercel';

const cloudProvider = createCloudProvider(vercelBackend, {
  // Vercel couples RAM to vCPU at 2048 MB/vCPU; disk is a fixed 32 GB NVMe.
  defaultResources: { cpu: 2, memory: 4, disk: 32 },
  launchDockerd: false,
});

/**
 * Vercel-specific checkpoint capability. Unlike the scaffold's default (which
 * stores a caller-chosen snapshot *name*), we capture the opaque Vercel
 * snapshot id and store THAT in the manifest's `snapshotName` field — the cloud
 * create flow passes `manifest.snapshotName` straight to
 * `provision({ snapshot })`, and the Vercel backend boots from it as a snapshot
 * id. (The scaffold's `cloudSnapshotName` project-scoping isn't needed — Vercel
 * snapshot ids are already globally unique.)
 */
const vercelCheckpoint: ProviderCheckpoint = {
  async create(box: BoxRecord, name: string) {
    if (!box.projectRoot) {
      throw new Error(
        'cloud checkpoint requires the box to have a project root (run `agentbox checkpoint` from inside the project)',
      );
    }
    if (!box.cloud?.sandboxId) {
      throw new Error(`vercel box ${box.name} has no sandboxId — record is malformed`);
    }
    // NOTE: snapshotting stops the source sandbox; persistent mode resumes it
    // on the next call. Surfaced to the user in `agentbox checkpoint` docs.
    const snapshotId = await snapshotVercelSandbox(box.cloud.sandboxId);
    // The box is now stopped — persist it so the fast `agentbox list` path
    // doesn't show a stale `running` after a checkpoint. Best-effort.
    try {
      await recordBox({ ...box, cloud: { ...box.cloud, lastState: 'paused' } });
    } catch {
      // not worth failing the checkpoint over a state-record write
    }
    const info = await writeCloudCheckpointManifest(box.projectRoot, BACKEND_NAME, name, {
      snapshotName: snapshotId,
      sourceBoxId: box.id,
      sourceBoxName: box.name,
      baseProvider: BACKEND_NAME,
      baseFingerprint: currentCloudBaseFingerprint(BACKEND_NAME),
      cliVersion: readCliStamp().cliVersion,
    });
    return { ref: info.name };
  },
  async list(projectRoot: string) {
    const entries = await listCloudCheckpoints(projectRoot, BACKEND_NAME);
    return entries.map((e) => ({ ref: e.name, createdAt: e.manifest.createdAt }));
  },
  async remove(projectRoot: string, ref: string) {
    const entry = await resolveCloudCheckpoint(projectRoot, BACKEND_NAME, ref);
    if (!entry) return;
    try {
      await deleteVercelSnapshot(entry.manifest.snapshotName);
    } catch {
      // best-effort: drop the local manifest even if the remote delete failed
      // (network/perms/already-gone) so the user isn't left with a dead pointer.
    }
    await removeCloudCheckpointDir(projectRoot, BACKEND_NAME, ref);
  },
};

export const vercelProvider: Provider = {
  ...cloudProvider,
  prepare: prepareVercelProvider,
  buildAttach: buildVercelAttach,
  checkpoint: vercelCheckpoint,
};

export { vercelBackend, DEFAULT_BOX_IMAGE_REF };
export { ensureVercelEnvLoaded, reloadVercelEnv } from './env-loader.js';
export { ensureVercelCredentials } from './credentials.js';
export type { EnsureVercelCredentialsOptions } from './credentials.js';
export {
  readVercelCredStatus,
  secretsPath,
  maskKey,
  type VercelCredStatus,
} from './credentials.js';
export {
  prepareVercel,
  prepareVercelProvider,
  type PrepareVercelOptions,
  type PrepareVercelResult,
} from './prepare.js';
export {
  ensureVercelBaseSnapshot,
  preparedStatePath,
  readPreparedState,
  writePreparedState,
  updatePreparedState,
  type PreparedVercelState,
  type PreparedVercelBase,
} from './prepared-state.js';
export {
  RUNTIME_ASSETS,
  candidatesFor,
  resolveRuntimeAssets,
  findStagedCliRuntimeRoot,
  type RuntimeAsset,
  type ResolvedAsset,
} from './runtime-assets.js';
export { buildVercelAttach } from './build-attach.js';
