/**
 * The remote-docker provider: `createCloudProvider(remoteDockerBackend)` plus
 * the four things the scaffold can't supply.
 *
 *   - `buildAttach` — the scaffold's SSH attach lands on the machine, not in
 *     the container; ours wraps the inner command in a `docker exec`.
 *   - `checkpoint`  — `docker commit` on the engine that runs the box, with the
 *     host carried in the snapshot name (see `parseSnapshotName`).
 *   - `prepare`     — bake the box image on a remote engine.
 *   - `baseFingerprint` — the docker build-context sha, so the CLI's
 *     "your base is stale" nag works the same way it does locally.
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
import { hashProjectPath, sanitizeMnemonic } from '@agentbox/config';
import { readCliStamp, type ProviderModule } from '@agentbox/sandbox-core';
import { basename } from 'node:path';
import { BACKEND_NAME, makeSnapshotName, remoteDockerBackend } from './backend.js';
import { buildRemoteDockerAttach } from './build-attach.js';
import { resolveBoxSshTarget } from './box-ssh.js';
import { currentContextSha } from './image.js';
import { prepareRemoteDocker } from './prepare.js';
import { parseSandboxId } from './target.js';
import { doctorChecks } from './provider-module.js';

const cloudProvider = createCloudProvider(remoteDockerBackend, {
  // Empty on purpose. The cloud default (2 cpu / 4 GB) would silently cap a box
  // on a 32-core workstation; a remote engine is the user's own machine, so a
  // box is unlimited unless `--size` says otherwise — the same deal the local
  // docker provider offers.
  defaultResources: {},
  launchDockerd: true,
});

/** The docker image a checkpoint commits to on the remote engine. */
function checkpointImageRef(projectRoot: string, name: string): string {
  const mnemonic = sanitizeMnemonic(basename(projectRoot));
  return `agentbox-ckpt-${hashProjectPath(projectRoot)}_${mnemonic}:${name}`;
}

const remoteDockerCheckpoint: ProviderCheckpoint = {
  async create(box: BoxRecord, name: string) {
    if (!box.projectRoot) {
      throw new Error(
        'checkpoint requires the box to have a project root (run `agentbox checkpoint` from inside the project)',
      );
    }
    const sandboxId = box.cloud?.sandboxId;
    if (!sandboxId) {
      throw new Error(`remote-docker box ${box.name} has no sandboxId — record is malformed`);
    }
    const { target } = parseSandboxId(sandboxId);
    const snapshotName = makeSnapshotName(target.spec, checkpointImageRef(box.projectRoot, name));
    await remoteDockerBackend.createSnapshot?.({ sandboxId }, snapshotName);

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
    await remoteDockerBackend.deleteSnapshot?.(entry.manifest.snapshotName);
    await removeCloudCheckpointDir(projectRoot, BACKEND_NAME, ref);
  },
};

export const remoteDockerProvider: Provider = {
  ...cloudProvider,
  buildAttach: buildRemoteDockerAttach,
  // The box's own sshd, reached by jumping through the engine — see box-ssh.ts.
  // Supplying this is what lets `open` / `code` / `connect` treat a remote-docker
  // box like any other SSH-capable box, without the scaffold having to guess a
  // target out of an attach argv that points at the engine rather than the box.
  sshTarget: resolveBoxSshTarget,
  checkpoint: remoteDockerCheckpoint,
  prepare: prepareRemoteDocker,
  baseFingerprint: async (claudeInstall) => (await currentContextSha(claudeInstall)) ?? undefined,
};

/** Uniform surface the CLI provider loader resolves this package through. */
export const providerModule: ProviderModule = {
  provider: remoteDockerProvider,
  backend: remoteDockerBackend,
  currentBaseFingerprintLive: async (claudeInstall) =>
    (await currentContextSha(claudeInstall)) ?? undefined,
  doctorChecks,
};

export { remoteDockerBackend, BACKEND_NAME, listOnHost } from './backend.js';
export { probeRemoteEngine } from './remote-docker.js';
export { parseRemoteTarget, parseSandboxId } from './target.js';
export { interactiveRegisterHost } from './host-setup.js';
