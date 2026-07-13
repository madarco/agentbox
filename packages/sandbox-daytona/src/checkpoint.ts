/**
 * Daytona cloud checkpoints.
 *
 * Overrides the generic cloud checkpoint (`makeCloudCheckpoint`) because
 * Daytona's capture has two properties the generic one doesn't model:
 *
 *  1. **A cold snapshot requires the sandbox STOPPED, and Daytona will not stop
 *     it for you.** (The hot, filesystem+memory variant needs `includeMemory`,
 *     which the published TS SDK silently drops — so it's out of reach until
 *     upstream fixes the wrapper.) So we stop, capture, and start again. The
 *     stop kills the in-box `ctl` daemon, dockerd, VNC and the agent's tmux
 *     session, so the box must be *reconnected* afterwards or the user is left
 *     with a running sandbox whose services are all dead.
 *
 *  2. **A snapshot name must never be reused.** Recreating a snapshot under a
 *     recently-deleted name yields one that reports `active` but cannot boot
 *     ("Sandbox failed to start: internal error") — Daytona's delete is async
 *     and racing it corrupts the new snapshot. `agentbox checkpoint rm <name>`
 *     followed by a re-create with the same name would walk straight into that,
 *     so the Daytona-side name carries a nonce while the user-facing checkpoint
 *     name stays whatever they typed. The manifest maps one to the other.
 */
import type { BoxRecord, Provider, ProviderCheckpoint } from '@agentbox/core';
import {
  cloudSnapshotName,
  currentCloudBaseFingerprint,
  listCloudCheckpoints,
  removeCloudCheckpointDir,
  resolveCloudCheckpoint,
  writeCloudCheckpointManifest,
} from '@agentbox/sandbox-cloud';
import { readCliStamp } from '@agentbox/sandbox-core';
import { daytonaBackend } from './backend.js';

const BACKEND_NAME = 'daytona';

export function makeDaytonaCheckpoint(cloudProvider: Provider): ProviderCheckpoint {
  return {
    async create(box: BoxRecord, name: string) {
      if (!box.projectRoot) {
        throw new Error(
          'cloud checkpoint requires the box to have a project root (run `agentbox checkpoint` from inside the project)',
        );
      }
      const sandboxId = box.cloud?.sandboxId;
      if (!sandboxId) {
        throw new Error(`daytona box ${box.name} has no sandboxId — record is malformed`);
      }
      const handle = { sandboxId, sandboxClass: box.cloud?.sandboxClass };
      // Unique per capture — see the name-reuse note above.
      const snapshotName = `${cloudSnapshotName(box.projectRoot, name)}-${Math.floor(Date.now() / 1000).toString(36)}`;

      await daytonaBackend.createSnapshot?.(handle, snapshotName);

      // The capture stopped and restarted the sandbox, so everything the box was
      // running is gone. `reconnect` re-runs the bootstrap (ctl, dockerd, VNC,
      // preview URLs) — without it the box looks up but answers nothing.
      await cloudProvider.reconnect(box);

      const info = await writeCloudCheckpointManifest(box.projectRoot, BACKEND_NAME, name, {
        snapshotName,
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
        await daytonaBackend.deleteSnapshot?.(entry.manifest.snapshotName);
      } catch {
        // Best-effort: drop the local manifest even when the remote delete fails,
        // so the user isn't left holding a pointer to nothing.
      }
      await removeCloudCheckpointDir(projectRoot, BACKEND_NAME, ref);
    },
  };
}
