/**
 * The E2B sandbox provider. A thin `CloudBackend` over the `e2b` v2 SDK,
 * composed via `@agentbox/sandbox-cloud`'s `createCloudProvider` for
 * everything provider-agnostic (workspace seeding, ctl launch, state, relay
 * polling).
 *
 * Three capabilities are overridden on top of the cloud scaffold:
 *   - `prepare`     — bake the custom base template via Template.build
 *                     (`agentbox prepare --provider e2b`).
 *   - `buildAttach` — SDK-streaming PTY bridge (E2B has no SSH).
 *   - `checkpoint`  — store the E2B snapshot id (template id) in the manifest
 *     so restore boots from it (`Sandbox.createSnapshot` produces an
 *     id-addressed reusable snapshot, same shape as Vercel).
 *
 * `launchDockerd: false` because E2B microVMs can't run nested containers.
 */

import type { BoxRecord, Provider, ProviderCheckpoint } from '@agentbox/core';
import {
  createCloudProvider,
  listCloudCheckpoints,
  removeCloudCheckpointDir,
  resolveCloudCheckpoint,
  writeCloudCheckpointManifest,
} from '@agentbox/sandbox-cloud';
import { recordBox } from '@agentbox/sandbox-core';
import { e2bBackend, DEFAULT_BOX_IMAGE_REF } from './backend.js';
import { Sandbox, resolveApiKey } from './sdk.js';
import { withE2bRetry } from './retry.js';
import { prepareE2bProvider } from './prepare.js';
import { buildE2bAttach } from './build-attach.js';

const BACKEND_NAME = 'e2b';

const cloudProvider = createCloudProvider(e2bBackend, {
  // E2B applies resources at the template level (Template.build({ cpuCount,
  // memoryMB }) — `prepare` sets these). The numbers below are advisory
  // metadata for BoxRecord stats / the dashboard pane; per-create overrides
  // aren't honored by the SDK.
  defaultResources: { cpu: 2, memory: 4, disk: 8 },
  launchDockerd: false,
});

/**
 * Create a reusable, named E2B snapshot from a running sandbox.
 * `Sandbox.createSnapshot` pauses the source while capturing, then returns a
 * persistent `snapshotId` (template id form: `name:tag` or `template-id:tag`)
 * usable with `Sandbox.create({ template })` — see SDK docs.
 */
async function createE2bSnapshot(sandboxId: string, name: string): Promise<string> {
  const apiKey = resolveApiKey();
  return withE2bRetry(
    { method: 'createSnapshot', retryOnAmbiguous: false, attemptTimeoutMs: 900_000, backoffMs: [] },
    async () => {
      const info = await Sandbox.createSnapshot(sandboxId, { apiKey, name });
      return info.snapshotId;
    },
  );
}

/** Delete a snapshot by id. Idempotent — a missing snapshot is success. */
async function deleteE2bSnapshot(snapshotId: string): Promise<void> {
  const apiKey = resolveApiKey();
  await withE2bRetry({ method: 'deleteSnapshot', retryOnAmbiguous: true }, async () => {
    try {
      await Sandbox.deleteSnapshot(snapshotId, { apiKey });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not.?found|404/i.test(msg)) return; // idempotent
      throw err;
    }
  });
}

/**
 * Build a safe, unique E2B snapshot name. E2B names are global within a team
 * (`createSnapshot({ name })` reuses an existing name if it exists, growing
 * the build set). We stamp a per-create timestamp so each checkpoint gets its
 * own name → its own template id, never overwriting an earlier checkpoint.
 */
function snapshotName(boxName: string, checkpointName: string): string {
  // E2B template names accept lower-case alnum + dashes/dots; coerce.
  const sanitize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  return `agentbox-${sanitize(boxName)}-${sanitize(checkpointName)}-${sanitize(ts)}`;
}

/**
 * E2B-specific checkpoint capability. Unlike the scaffold's default (which
 * stores a caller-chosen snapshot *name*), we capture the SDK-returned
 * opaque snapshot id and store THAT in the manifest's `snapshotName` field —
 * the cloud create flow passes `manifest.snapshotName` straight to
 * `provision({ snapshot })`, and the E2B backend boots from it as a template
 * id. (Same id-addressed shape as Vercel's checkpoint capability.)
 */
const e2bCheckpoint: ProviderCheckpoint = {
  async create(box: BoxRecord, name: string) {
    if (!box.projectRoot) {
      throw new Error(
        'cloud checkpoint requires the box to have a project root (run `agentbox checkpoint` from inside the project)',
      );
    }
    if (!box.cloud?.sandboxId) {
      throw new Error(`e2b box ${box.name} has no sandboxId — record is malformed`);
    }
    // NOTE: createSnapshot pauses the source sandbox; agentbox-ctl-checkpoint
    // resumes it lazily on the next op (Sandbox.connect auto-resumes).
    const e2bSnapName = snapshotName(box.name, name);
    const snapshotId = await createE2bSnapshot(box.cloud.sandboxId, e2bSnapName);
    // The box is now paused — persist it so the fast `agentbox list` path
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
      await deleteE2bSnapshot(entry.manifest.snapshotName);
    } catch {
      // best-effort: drop the local manifest even if the remote delete failed
      // (network/perms/already-gone) so the user isn't left with a dead pointer.
    }
    await removeCloudCheckpointDir(projectRoot, BACKEND_NAME, ref);
  },
};

export const e2bProvider: Provider = {
  ...cloudProvider,
  prepare: prepareE2bProvider,
  buildAttach: buildE2bAttach,
  checkpoint: e2bCheckpoint,
};

export { e2bBackend, DEFAULT_BOX_IMAGE_REF };
export { ensureE2bEnvLoaded, reloadE2bEnv } from './env-loader.js';
export {
  ensureE2bCredentials,
  readE2bCredStatus,
  secretsPath,
  maskKey,
  type EnsureE2bCredentialsOptions,
  type E2bCredStatus,
} from './credentials.js';
export {
  RUNTIME_ASSETS,
  candidatesFor,
  resolveRuntimeAssets,
  findStagedCliRuntimeRoot,
  type RuntimeAsset,
  type ResolvedAsset,
} from './runtime-assets.js';
export {
  prepareE2b,
  prepareE2bProvider,
  type PrepareE2bOptions,
  type PrepareE2bResult,
} from './prepare.js';
export {
  ensureE2bBaseTemplate,
  preparedStatePath,
  readPreparedState,
  writePreparedState,
  updatePreparedState,
  type PreparedE2bState,
  type PreparedE2bBase,
} from './prepared-state.js';
export { buildE2bAttach } from './build-attach.js';
