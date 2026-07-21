/**
 * agentbox-provider-example — a REAL, working provider plugin (Vercel-backed),
 * built ONLY on `@madarco/agentbox-provider-sdk`. It is a faithful copy of the built-in
 * Vercel provider, repackaged as an external plugin to prove the full plugin
 * surface end-to-end and to serve as the canonical copy-me reference. It is an
 * internal test/example — not published.
 *
 * A thin `CloudBackend` over `@vercel/sandbox` (see backend.ts), composed via the
 * SDK's `createCloudProvider` for everything provider-agnostic (workspace
 * seeding, ctl/VNC/dockerd launch, state, relay polling, cp). Three capabilities
 * are overridden on top of the scaffold:
 *   - `prepare`     — bake the base snapshot (Vercel can't build from a Dockerfile).
 *   - `buildAttach` — SDK-streaming tmux bridge (Vercel has no SSH).
 *   - `checkpoint`  — store the Vercel snapshot *id* in the manifest so restore
 *     boots from it (Vercel snapshots are id-addressed, not name-addressed). This
 *     is the capability that needs the SDK's cloud-checkpoint authoring helpers.
 */

import {
  createCloudProvider,
  currentCloudBaseFingerprint,
  listCloudCheckpoints,
  removeCloudCheckpointDir,
  resolveCloudCheckpoint,
  writeCloudCheckpointManifest,
  readCliStamp,
  recordBox,
  type BoxRecord,
  type Provider,
  type ProviderCheckpoint,
  type ProviderModule,
} from '@madarco/agentbox-provider-sdk';
import {
  exampleBackend,
  snapshotExampleSandbox,
  deleteExampleSnapshot,
  DEFAULT_BOX_IMAGE_REF,
} from './backend.js';
import { prepareExampleProvider } from './prepare.js';
import { buildExampleAttach } from './build-attach.js';
import { currentExampleBaseFingerprintLive } from './prepared-state.js';
import { ensureExampleCredentials } from './credentials.js';
import { doctorChecks, readCredStatusSummary } from './provider-module.js';

const BACKEND_NAME = 'example';

const cloudProvider = createCloudProvider(exampleBackend, {
  // Vercel couples RAM to vCPU at 2048 MB/vCPU; disk is a fixed 32 GB NVMe.
  defaultResources: { cpu: 2, memory: 4, disk: 32 },
  launchDockerd: true,
});

/**
 * Example-provider checkpoint capability. Unlike the scaffold's default (which
 * stores a caller-chosen snapshot *name* and drives `backend.createSnapshot`),
 * we capture the opaque Vercel snapshot id and store THAT in the manifest's
 * `snapshotName` field — the cloud create flow passes `manifest.snapshotName`
 * straight to `provision({ snapshot })`, and the backend boots from it as a
 * snapshot id. This override is only possible because the SDK re-exports the
 * cloud-checkpoint manifest helpers below.
 */
const exampleCheckpoint: ProviderCheckpoint = {
  async create(box: BoxRecord, name: string) {
    if (!box.projectRoot) {
      throw new Error(
        'cloud checkpoint requires the box to have a project root (run `agentbox checkpoint` from inside the project)',
      );
    }
    if (!box.cloud?.sandboxId) {
      throw new Error(`example box ${box.name} has no sandboxId — record is malformed`);
    }
    // NOTE: snapshotting stops the source sandbox; persistent mode resumes it
    // on the next call.
    const snapshotId = await snapshotExampleSandbox(box.cloud.sandboxId);
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
      await deleteExampleSnapshot(entry.manifest.snapshotName);
    } catch {
      // best-effort: drop the local manifest even if the remote delete failed
      // so the user isn't left with a dead pointer.
    }
    await removeCloudCheckpointDir(projectRoot, BACKEND_NAME, ref);
  },
};

export const exampleProvider: Provider = {
  ...cloudProvider,
  prepare: prepareExampleProvider,
  buildAttach: buildExampleAttach,
  checkpoint: exampleCheckpoint,
  baseFingerprint: () => currentExampleBaseFingerprintLive(),
};

/** Uniform surface the CLI provider loader resolves this package through. */
export const providerModule: ProviderModule = {
  provider: exampleProvider,
  backend: exampleBackend,
  ensureCredentials: ensureExampleCredentials,
  readCredStatus: readCredStatusSummary,
  currentBaseFingerprintLive: (claudeInstall) => currentExampleBaseFingerprintLive(claudeInstall),
  doctorChecks,
};

export { exampleBackend, DEFAULT_BOX_IMAGE_REF };
