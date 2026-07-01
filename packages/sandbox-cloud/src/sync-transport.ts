/**
 * `CloudSyncTransport` — the cloud implementation of the `SyncTransport` seam
 * (`@agentbox/core`). Wraps a `CloudBackend` + `CloudHandle`: `exec` →
 * `backend.exec`, `applyTarball` → `uploadFile` + `backend.exec(tar -xf …)`,
 * pull → `backend.downloadFile`.
 *
 * `applyTarball` reproduces `uploadEnvFiles`'s extract exactly (`--no-same-
 * permissions --no-same-owner -m`), which also future-proofs against a
 * FUSE-volume `/workspace` tier. `caps.helperContainer` is false — cloud static
 * config is baked into the snapshot at `prepare` time, so `seedVolumeFromHost`
 * is omitted; `ensureVolume` is present only when the backend has a volume API.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type {
  CloudBackend,
  CloudHandle,
  PushOptions,
  SyncExecOptions,
  SyncExecResult,
  SyncTransport,
  TransportCaps,
} from '@agentbox/core';
import { quoteShellArgv } from './shell.js';

export interface CloudSyncTransportInit {
  backend: CloudBackend;
  handle: CloudHandle;
}

export function createCloudSyncTransport(init: CloudSyncTransportInit): SyncTransport {
  const { backend, handle } = init;
  const hasVolume = typeof backend.ensureVolume === 'function';
  let tarSeq = 0;

  const caps: TransportCaps = {
    persistentVolumes: hasVolume,
    helperContainer: false,
    ephemeralFs: !hasVolume,
  };

  const transport: SyncTransport = {
    caps,

    async exec(cmd: string[], opts?: SyncExecOptions): Promise<SyncExecResult> {
      const r = await backend.exec(handle, quoteShellArgv(cmd), {
        cwd: opts?.cwd,
        env: opts?.env,
        user: opts?.user,
        attemptTimeoutMs: opts?.attemptTimeoutMs,
        noRetry: opts?.noRetry,
      });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },

    async applyTarball(hostTarPath: string, boxDestDir: string): Promise<void> {
      const remoteTar = `/tmp/agentbox-apply-${String(tarSeq++)}.tar`;
      await backend.uploadFile(handle, hostTarPath, remoteTar);
      const r = await backend.exec(
        handle,
        `tar -xf ${remoteTar} -C ${boxDestDir} --no-same-permissions --no-same-owner -m && rm -f ${remoteTar}`,
      );
      if (r.exitCode !== 0) {
        throw new Error(
          `cloud tar extract into ${boxDestDir} failed (exit ${String(r.exitCode)}): ${r.stderr.slice(-200)}`,
        );
      }
    },

    async pushTree(hostSrcDir: string, boxDestDir: string, opts?: PushOptions): Promise<void> {
      const stage = await mkdtemp(join(tmpdir(), 'agentbox-pushtree-'));
      const localTar = join(stage, 'tree.tar');
      try {
        const packArgs = ['-C', hostSrcDir];
        for (const ex of opts?.exclude ?? []) packArgs.push(`--exclude=${ex}`);
        packArgs.push('-cf', localTar, '.');
        const packed = await execa('tar', packArgs, { reject: false });
        if (packed.exitCode !== 0) {
          throw new Error(`tar pack of ${hostSrcDir} failed: ${String(packed.stderr).slice(0, 300)}`);
        }
        await transport.applyTarball(localTar, boxDestDir, opts);
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    },

    async pushFile(hostSrcPath: string, boxDestPath: string, opts?: PushOptions): Promise<void> {
      await backend.uploadFile(handle, hostSrcPath, boxDestPath);
      if (opts?.uid !== undefined && opts.uid !== 0) {
        await backend.exec(handle, `chown ${String(opts.uid)}:${String(opts.uid)} ${boxDestPath}`);
      }
      if (opts?.mode !== undefined) {
        await backend.exec(handle, `chmod ${opts.mode.toString(8)} ${boxDestPath}`);
      }
    },

    async pullTree(boxSrcDir: string, hostDestDir: string, opts?: { exclude?: string[] }): Promise<void> {
      const remoteTar = `/tmp/agentbox-pull-${String(tarSeq++)}.tar`;
      const excludes = (opts?.exclude ?? []).map((e) => `--exclude=${e}`).join(' ');
      const pack = await backend.exec(
        handle,
        `tar -C ${boxSrcDir} ${excludes} -cf ${remoteTar} .`,
      );
      if (pack.exitCode !== 0) {
        throw new Error(`cloud tar of ${boxSrcDir} failed: ${pack.stderr.slice(-200)}`);
      }
      const stage = await mkdtemp(join(tmpdir(), 'agentbox-pulltree-'));
      const localTar = join(stage, 'tree.tar');
      try {
        await backend.downloadFile(handle, remoteTar, localTar);
        await execa('tar', ['-xf', localTar, '-C', hostDestDir], { reject: false });
      } finally {
        await rm(stage, { recursive: true, force: true });
        await backend.exec(handle, `rm -f ${remoteTar}`).catch(() => {});
      }
    },

    async pullFile(boxSrcPath: string, hostDestPath: string): Promise<void> {
      await backend.downloadFile(handle, boxSrcPath, hostDestPath);
    },

    async readText(boxPath: string): Promise<string | null> {
      const r = await backend.exec(handle, `cat ${boxPath} 2>/dev/null`, { noRetry: true });
      if (r.exitCode !== 0) return null;
      return r.stdout;
    },
  };

  if (hasVolume) {
    transport.ensureVolume = async (name: string): Promise<{ volumeId: string }> => {
      const ensured = await backend.ensureVolume!(name);
      return ensured;
    };
  }
  // seedVolumeFromHost intentionally omitted: cloud static config is baked into
  // the snapshot at `prepare` time (caps.helperContainer === false).

  return transport;
}
