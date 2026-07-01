/**
 * `DockerSyncTransport` — the docker implementation of the `SyncTransport` seam
 * (`@agentbox/core`). Every method is a thin wrapper over the `docker` CLI
 * primitives the provider already uses (`docker exec`/`cp`/`run`), so it needs
 * only a container name (works at create time, before a full `BoxRecord`).
 *
 * `applyTarball` reproduces `copyHostEnvFilesToBox`'s extract exactly:
 * `docker exec -i --user <uid>:<uid> <c> tar -xf - -C <dest>` streaming the
 * tarball via stdin.
 */

import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type {
  PushOptions,
  SyncExecOptions,
  SyncExecResult,
  SyncTransport,
  TransportCaps,
  VolumeHostSource,
} from '@agentbox/core';

export interface DockerSyncTransportInit {
  /** Target container name (running, overlay mounted). */
  container: string;
  /** Image for the throwaway rsync helper container (`seedVolumeFromHost`). */
  image?: string;
}

const DOCKER_CAPS: TransportCaps = {
  persistentVolumes: true,
  helperContainer: true,
  ephemeralFs: false,
};

export function createDockerSyncTransport(init: DockerSyncTransportInit): SyncTransport {
  const { container } = init;

  const execArgsPrefix = (opts?: SyncExecOptions): string[] => {
    const pre: string[] = ['exec'];
    if (opts?.user) pre.push('--user', opts.user);
    if (opts?.cwd) pre.push('-w', opts.cwd);
    for (const [k, v] of Object.entries(opts?.env ?? {})) pre.push('-e', `${k}=${v}`);
    return pre;
  };

  const transport: SyncTransport = {
    caps: DOCKER_CAPS,

    async exec(cmd: string[], opts?: SyncExecOptions): Promise<SyncExecResult> {
      const r = await execa('docker', [...execArgsPrefix(opts), container, ...cmd], {
        reject: false,
      });
      return {
        exitCode: typeof r.exitCode === 'number' ? r.exitCode : 1,
        stdout: String(r.stdout ?? ''),
        stderr: String(r.stderr ?? ''),
      };
    },

    async applyTarball(hostTarPath: string, boxDestDir: string, opts?: PushOptions): Promise<void> {
      const uid = opts?.uid ?? 1000;
      const tarArgs = ['tar', '-xf', '-', '-C', boxDestDir];
      if (opts?.noSamePerms) tarArgs.push('--no-same-permissions', '--no-same-owner', '-m');
      const args =
        uid === 0
          ? ['exec', '-i', container, ...tarArgs]
          : ['exec', '-i', '--user', `${uid}:${uid}`, container, ...tarArgs];
      const r = await execa('docker', args, { input: createReadStream(hostTarPath), reject: false });
      if (r.exitCode !== 0) {
        throw new Error(`docker tar extract into ${boxDestDir} failed: ${String(r.stderr).slice(0, 300)}`);
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
      const cp = await execa('docker', ['cp', hostSrcPath, `${container}:${boxDestPath}`], {
        reject: false,
      });
      if (cp.exitCode !== 0) {
        throw new Error(`docker cp into ${boxDestPath} failed: ${String(cp.stderr).slice(0, 300)}`);
      }
      if (opts?.uid !== undefined && opts.uid !== 0) {
        await this.exec(['chown', `${opts.uid}:${opts.uid}`, boxDestPath]);
      }
      if (opts?.mode !== undefined) {
        await this.exec(['chmod', opts.mode.toString(8), boxDestPath]);
      }
    },

    async pullTree(boxSrcDir: string, hostDestDir: string, opts?: { exclude?: string[] }): Promise<void> {
      const tarArgs = ['exec', container, 'tar', '-C', boxSrcDir];
      for (const ex of opts?.exclude ?? []) tarArgs.push(`--exclude=${ex}`);
      tarArgs.push('-cf', '-', '.');
      const packed = await execa('docker', tarArgs, { encoding: 'buffer', reject: false });
      if (packed.exitCode !== 0) {
        throw new Error(`docker tar of ${boxSrcDir} failed: ${String(packed.stderr).slice(0, 300)}`);
      }
      await execa('tar', ['-xf', '-', '-C', hostDestDir], {
        input: packed.stdout as Buffer,
        reject: false,
      });
    },

    async pullFile(boxSrcPath: string, hostDestPath: string): Promise<void> {
      const cp = await execa('docker', ['cp', `${container}:${boxSrcPath}`, hostDestPath], {
        reject: false,
      });
      if (cp.exitCode !== 0) {
        throw new Error(`docker cp from ${boxSrcPath} failed: ${String(cp.stderr).slice(0, 300)}`);
      }
    },

    async readText(boxPath: string): Promise<string | null> {
      const r = await execa('docker', ['exec', container, 'cat', boxPath], { reject: false });
      if (r.exitCode !== 0) return null;
      return String(r.stdout ?? '');
    },

    async ensureVolume(name: string): Promise<{ volumeId: string }> {
      await execa('docker', ['volume', 'create', name], { reject: false });
      return { volumeId: name };
    },

    async seedVolumeFromHost(volume: string, sources: VolumeHostSource[]): Promise<void> {
      if (!init.image) throw new Error('seedVolumeFromHost requires an image');
      const args = ['run', '--rm', '--user', '0', '-v', `${volume}:/dst`];
      const steps: string[] = [];
      sources.forEach((src, i) => {
        const mount = `/src-${String(i)}`;
        args.push('-v', `${src.hostDir}:${mount}:ro`);
        const dest = src.destSubpath ? `/dst/${src.destSubpath}` : '/dst';
        const rsync = ['rsync', '-a'];
        if (src.update) rsync.push('--update');
        for (const ex of src.exclude ?? []) rsync.push(`--exclude=${ex}`);
        rsync.push(`${mount}/`, `${dest}/`);
        steps.push(`mkdir -p ${dest} && ${rsync.join(' ')}`);
      });
      steps.push('chown -R 1000:1000 /dst');
      args.push(init.image, 'sh', '-c', steps.join(' && '));
      const r = await execa('docker', args, { reject: false });
      if (r.exitCode !== 0) {
        throw new Error(`seedVolumeFromHost(${volume}) failed: ${String(r.stderr).slice(0, 300)}`);
      }
    },
  };

  return transport;
}
