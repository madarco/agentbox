/**
 * The docker implementations of the `SyncTransport` seam (`@agentbox/core`).
 *
 * Two of them, over one body:
 *
 *  - **container mode** (`createDockerSyncTransport`) — `docker exec`/`cp`
 *    against a RUNNING box. Needs only a container name, so it works at create
 *    time before a full `BoxRecord` exists.
 *  - **volume mode** (`createDockerVolumeSyncTransport`) — a throwaway helper
 *    container with the box's config volume bind-mounted AT ITS BOX PATH, so a
 *    caller writes the same box-absolute paths either way and the box does not
 *    have to be running. This is what the per-agent pulls need: they are
 *    documented as working against a stopped box, which is why each of them
 *    used to hand-roll its own `docker run -v` instead of using the transport.
 *
 * The two differ ONLY in how a command reaches the box filesystem — the tar
 * flags, the exclude handling and the ownership rules are written once here.
 * `applyTarball` reproduces `copyHostEnvFilesToBox`'s extract exactly.
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

export interface DockerVolumeSyncTransportInit {
  /** The docker volume standing in for the box filesystem. */
  volume: string;
  /**
   * Where that volume is mounted inside a real box (`/home/vscode/.claude`).
   *
   * Load-bearing: the helper container mounts it at the SAME path, so every
   * box-absolute path a caller passes resolves identically in both modes. Take
   * it from the registry (`staticPaths[0].boxDir`), never a literal.
   */
  mountPath: string;
  /** Image the helper container runs (needs `tar`, and `rsync` for seeding). */
  image: string;
}

/**
 * macOS `tar` writes an AppleDouble `._name` sidecar per entry unless this is
 * set, and those land in the box as garbage files (and made a one-entry push
 * fail outright, since the sidecar is extracted too).
 */
const HOST_TAR_ENV = { ...process.env, COPYFILE_DISABLE: '1' };

const DOCKER_CAPS: TransportCaps = {
  persistentVolumes: true,
  helperContainer: true,
  ephemeralFs: false,
};

/** How a command reaches the box filesystem. The only thing the modes differ in. */
interface DockerRunner {
  /** Full `docker` argv running `cmd` against the box filesystem. */
  argv(cmd: string[], opts?: RunnerOptions): string[];
  /**
   * `docker cp` argv, or null when the mode has no cp (volume mode: there is no
   * container to address). Callers fall back to a tar stream.
   */
  cpIn(hostPath: string, boxPath: string): string[] | null;
  cpOut(boxPath: string, hostPath: string): string[] | null;
  /**
   * Who runs a tar extract.
   *
   * Container mode pins the box uid, because the box's own dirs are already
   * owned by it. A helper container has no such luxury: the volume's dirs are
   * root-owned, so a `--user 1000` extract fails with "Permission denied" —
   * found by round-tripping a real volume, not by reading. Volume mode extracts
   * as root and chowns after, exactly as the hand-rolled agent containers did.
   */
  extractUser(uid: number): string;
  /** True when a write must be chowned afterwards (volume mode). */
  chownAfterWrite: boolean;
}

interface RunnerOptions extends SyncExecOptions {
  /** Keep stdin open (`-i`) for a streamed tarball. */
  stdin?: boolean;
  /** Mount the box filesystem read-only. Volume mode only; ignored on exec. */
  readOnly?: boolean;
}

function containerRunner(container: string): DockerRunner {
  return {
    argv(cmd, opts) {
      const pre: string[] = ['exec'];
      if (opts?.stdin) pre.push('-i');
      if (opts?.user) pre.push('--user', opts.user);
      if (opts?.cwd) pre.push('-w', opts.cwd);
      for (const [k, v] of Object.entries(opts?.env ?? {})) pre.push('-e', `${k}=${v}`);
      return [...pre, container, ...cmd];
    },
    cpIn: (hostPath, boxPath) => ['cp', hostPath, `${container}:${boxPath}`],
    cpOut: (boxPath, hostPath) => ['cp', `${container}:${boxPath}`, hostPath],
    extractUser: (uid) => `${uid}:${uid}`,
    chownAfterWrite: false,
  };
}

function volumeRunner(init: DockerVolumeSyncTransportInit): DockerRunner {
  return {
    argv(cmd, opts) {
      const pre: string[] = ['run', '--rm'];
      if (opts?.stdin) pre.push('-i');
      // Default to root: the helper has no box user session and every write
      // here is followed by an explicit chown, exactly as the hand-rolled
      // per-agent containers did.
      pre.push('--user', opts?.user ?? '0');
      if (opts?.cwd) pre.push('-w', opts.cwd);
      for (const [k, v] of Object.entries(opts?.env ?? {})) pre.push('-e', `${k}=${v}`);
      pre.push('-v', `${init.volume}:${init.mountPath}${opts?.readOnly ? ':ro' : ''}`);
      return [...pre, init.image, ...cmd];
    },
    // No container to address; the transport falls back to a tar stream.
    cpIn: () => null,
    cpOut: () => null,
    extractUser: () => '0',
    chownAfterWrite: true,
  };
}

function makeTransport(runner: DockerRunner, image: string | undefined): SyncTransport {
  const transport: SyncTransport = {
    caps: DOCKER_CAPS,

    async exec(cmd: string[], opts?: SyncExecOptions): Promise<SyncExecResult> {
      const r = await execa('docker', runner.argv(cmd, opts), { reject: false });
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
      // Always pin the extract user explicitly (`--user <uid>:<uid>`), incl.
      // `0:0` for root — omitting it would run as the image's default USER
      // (vscode), which is wrong for a root-owned carry extract.
      const args = runner.argv(tarArgs, { stdin: true, user: runner.extractUser(uid) });
      const r = await execa('docker', args, {
        input: createReadStream(hostTarPath),
        reject: false,
      });
      if (r.exitCode !== 0) {
        throw new Error(
          `docker tar extract into ${boxDestDir} failed: ${String(r.stderr).slice(0, 300)}`,
        );
      }
      if (runner.chownAfterWrite && uid !== 0) {
        await transport.exec(['chown', '-R', `${uid}:${uid}`, boxDestDir], { user: '0' });
      }
    },

    async pushTree(hostSrcDir: string, boxDestDir: string, opts?: PushOptions): Promise<void> {
      const stage = await mkdtemp(join(tmpdir(), 'agentbox-pushtree-'));
      const localTar = join(stage, 'tree.tar');
      try {
        const packArgs = ['-C', hostSrcDir];
        for (const ex of opts?.exclude ?? []) packArgs.push(`--exclude=${ex}`);
        packArgs.push('-cf', localTar, '.');
        const packed = await execa('tar', packArgs, { reject: false, env: HOST_TAR_ENV });
        if (packed.exitCode !== 0) {
          throw new Error(
            `tar pack of ${hostSrcDir} failed: ${String(packed.stderr).slice(0, 300)}`,
          );
        }
        await transport.applyTarball(localTar, boxDestDir, opts);
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    },

    async pushFile(hostSrcPath: string, boxDestPath: string, opts?: PushOptions): Promise<void> {
      const cp = runner.cpIn(hostSrcPath, boxDestPath);
      if (cp) {
        const r = await execa('docker', cp, { reject: false });
        if (r.exitCode !== 0) {
          throw new Error(
            `docker cp into ${boxDestPath} failed: ${String(r.stderr).slice(0, 300)}`,
          );
        }
      } else {
        // No cp in volume mode: stream a one-entry tarball instead. `-C` on the
        // host side plus the basename keeps the archive path relative, so the
        // extract lands the file at exactly `boxDestPath`.
        const dir = boxDestPath.slice(0, boxDestPath.lastIndexOf('/')) || '/';
        const base = boxDestPath.slice(boxDestPath.lastIndexOf('/') + 1);
        const hostDir = hostSrcPath.slice(0, hostSrcPath.lastIndexOf('/')) || '.';
        const hostBase = hostSrcPath.slice(hostSrcPath.lastIndexOf('/') + 1);
        const stage = await mkdtemp(join(tmpdir(), 'agentbox-pushfile-'));
        const localTar = join(stage, 'file.tar');
        try {
          const packed = await execa(
            'tar',
            ['-C', hostDir, '-cf', localTar, `--transform=s|^${hostBase}$|${base}|`, hostBase],
            { reject: false, env: HOST_TAR_ENV },
          );
          if (packed.exitCode !== 0) {
            // BSD tar has no --transform; fall back to a plain pack + rename.
            await execa('tar', ['-C', hostDir, '-cf', localTar, hostBase], {
              reject: false,
              env: HOST_TAR_ENV,
            });
            await transport.applyTarball(localTar, dir, opts);
            if (hostBase !== base) {
              await transport.exec(['mv', `${dir}/${hostBase}`, boxDestPath], { user: '0' });
            }
          } else {
            await transport.applyTarball(localTar, dir, opts);
          }
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      }
      if (opts?.uid !== undefined && opts.uid !== 0) {
        await transport.exec(['chown', `${opts.uid}:${opts.uid}`, boxDestPath], { user: '0' });
      }
      if (opts?.mode !== undefined) {
        await transport.exec(['chmod', opts.mode.toString(8), boxDestPath], { user: '0' });
      }
    },

    async pullTree(
      boxSrcDir: string,
      hostDestDir: string,
      opts?: { exclude?: string[] },
    ): Promise<void> {
      const tarArgs = ['tar', '-C', boxSrcDir];
      for (const ex of opts?.exclude ?? []) tarArgs.push(`--exclude=${ex}`);
      tarArgs.push('-cf', '-', '.');
      const packed = await execa('docker', runner.argv(tarArgs, { readOnly: true }), {
        encoding: 'buffer',
        reject: false,
      });
      if (packed.exitCode !== 0) {
        throw new Error(
          `docker tar of ${boxSrcDir} failed: ${String(packed.stderr).slice(0, 300)}`,
        );
      }
      await execa('tar', ['-xf', '-', '-C', hostDestDir], {
        input: packed.stdout as Buffer,
        reject: false,
      });
    },

    async pullFile(boxSrcPath: string, hostDestPath: string): Promise<void> {
      const cp = runner.cpOut(boxSrcPath, hostDestPath);
      if (cp) {
        const r = await execa('docker', cp, { reject: false });
        if (r.exitCode !== 0) {
          throw new Error(`docker cp from ${boxSrcPath} failed: ${String(r.stderr).slice(0, 300)}`);
        }
        return;
      }
      // Volume mode: stream the single entry out through tar, preserving mode
      // (a `cat` redirect would not — `auth.json` has to stay 0600).
      const dir = boxSrcPath.slice(0, boxSrcPath.lastIndexOf('/')) || '/';
      const base = boxSrcPath.slice(boxSrcPath.lastIndexOf('/') + 1);
      const packed = await execa(
        'docker',
        runner.argv(['tar', '-C', dir, '-cf', '-', base], { readOnly: true }),
        { encoding: 'buffer', reject: false },
      );
      if (packed.exitCode !== 0) {
        throw new Error(
          `docker tar of ${boxSrcPath} failed: ${String(packed.stderr).slice(0, 300)}`,
        );
      }
      const hostDir = hostDestPath.slice(0, hostDestPath.lastIndexOf('/')) || '.';
      const hostBase = hostDestPath.slice(hostDestPath.lastIndexOf('/') + 1);
      await execa('tar', ['-xf', '-', '-C', hostDir], {
        input: packed.stdout as Buffer,
        reject: false,
      });
      if (hostBase !== base) {
        await execa('mv', [join(hostDir, base), hostDestPath], { reject: false });
      }
    },

    async readText(boxPath: string): Promise<string | null> {
      const r = await execa('docker', runner.argv(['cat', boxPath], { readOnly: true }), {
        reject: false,
      });
      if (r.exitCode !== 0) return null;
      return String(r.stdout ?? '');
    },

    async ensureVolume(name: string): Promise<{ volumeId: string }> {
      await execa('docker', ['volume', 'create', name], { reject: false });
      return { volumeId: name };
    },

    async seedVolumeFromHost(volume: string, sources: VolumeHostSource[]): Promise<void> {
      if (!image) throw new Error('seedVolumeFromHost requires an image');
      const args = ['run', '--rm', '--user', '0', '-v', `${volume}:/dst`];
      const steps: string[] = [];
      sources.forEach((src, i) => {
        const mount = `/src-${String(i)}`;
        args.push('-v', `${src.hostDir}:${mount}:ro`);
        const dest = src.destSubpath ? `/dst/${src.destSubpath}` : '/dst';
        const rsync = ['rsync', '-a'];
        if (src.copyUnsafeLinks) rsync.push('--copy-unsafe-links');
        if (src.update) rsync.push('--update');
        for (const inc of src.include ?? []) rsync.push(`--include=${inc}`);
        for (const ex of src.exclude ?? []) rsync.push(`--exclude=${ex}`);
        rsync.push(`${mount}/`, `${dest}/`);
        steps.push(`mkdir -p ${dest} && ${rsync.join(' ')}`);
      });
      steps.push('chown -R 1000:1000 /dst');
      args.push(image, 'sh', '-c', steps.join(' && '));
      const r = await execa('docker', args, { reject: false });
      if (r.exitCode !== 0) {
        throw new Error(`seedVolumeFromHost(${volume}) failed: ${String(r.stderr).slice(0, 300)}`);
      }
    },
  };

  return transport;
}

export function createDockerSyncTransport(init: DockerSyncTransportInit): SyncTransport {
  return makeTransport(containerRunner(init.container), init.image);
}

/**
 * A `SyncTransport` over a docker VOLUME rather than a running container.
 *
 * The box need not exist. Used by the per-agent pulls, which have always been
 * documented as working against a stopped box — each of them used to reach for
 * `docker run -v` directly, which is how three of them ended up with three
 * different inventory dialects and only one of them preserving `auth.json`'s
 * 0600.
 */
export function createDockerVolumeSyncTransport(
  init: DockerVolumeSyncTransportInit,
): SyncTransport {
  return makeTransport(volumeRunner(init), init.image);
}

/** Exported for the argv tests — the two modes must stay path-compatible. */
export const __testing = { containerRunner, volumeRunner };
