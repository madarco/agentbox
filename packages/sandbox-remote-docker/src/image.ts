/**
 * Getting the box image onto the remote engine.
 *
 * The image ref IS the build-context fingerprint: `agentbox/box:<sha16>`, the
 * same sha the local docker provider computes. That one decision removes a
 * whole class of state:
 *
 *   - "is this host prepared?" == `docker image inspect agentbox/box:<sha>` on it.
 *     No prepared-state file is consulted to decide, so it can't go stale or
 *     disagree with reality, and it is naturally PER HOST (which a single
 *     `~/.agentbox/remote-docker-prepared.json` could never be).
 *   - a CLI upgrade that changes any baked file changes the sha, so the next
 *     create ensures a new ref rather than silently running an old image.
 *
 * Ensure order: already present → pull the fingerprint-tagged image from GHCR
 * (published multi-arch, so an amd64 remote gets amd64 even though the laptop
 * is arm64) → stream the local build context to a temp dir on the remote and
 * build it there.
 */

import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { quoteShellArg } from '@agentbox/sandbox-cloud';
import {
  BOX_IMAGE_REGISTRY,
  BUILD_CONTEXT_DIR,
  computeDockerContextFingerprint,
  registryRefForSha,
} from '@agentbox/sandbox-docker';
import {
  agentInstallFingerprint,
  sshDestination,
  sshOptArgs,
  type SshTargetArgs,
} from '@agentbox/sandbox-core';
import { dockerOnRemote, loginShell } from './remote-docker.js';

export type ClaudeInstall = 'native' | 'npm';

export interface EnsureRemoteImageOptions {
  /** Pin an explicit image ref on the remote (`box.imageRemoteDocker`); skips the ensure. */
  imageRef?: string;
  agentInstall?: ClaudeInstall;
  /** Registry to pull from. Empty string disables the pull and forces a build. */
  registry?: string;
  /** Force the build path even on a registry hit (`--build`). */
  allowPull?: boolean;
  /** Rebuild even when the ref is already present on the remote. */
  force?: boolean;
  onLog?: (line: string) => void;
}

export interface EnsureRemoteImageResult {
  ref: string;
  source: 'pinned' | 'present' | 'pulled' | 'built';
  /** The build-context fingerprint the ref encodes, when we derived it. */
  contextSha256?: string;
}

/** The image ref a given build-context fingerprint maps to on the remote. */
export function remoteImageRef(contextSha256: string): string {
  return `agentbox/box:${contextSha256.slice(0, 16)}`;
}

/**
 * Resolve the fingerprint of the build context this CLI would bake, folding in
 * the Claude install mode exactly as the docker provider does (so an npm-baked
 * image and a native-baked one are different refs, not the same ref with
 * different contents). Null when the context can't be resolved — a dev tree
 * without `pnpm -w build`.
 */
export async function currentContextSha(agentInstall?: ClaudeInstall): Promise<string | null> {
  const fp = await computeDockerContextFingerprint({});
  if (!fp) return null;
  return agentInstall
    ? agentInstallFingerprint(fp.contextSha256, agentInstall)
    : fp.contextSha256;
}

/**
 * Make the box image present on the remote engine. Idempotent and cheap on the
 * hot path: a single `docker image inspect` when it's already there.
 */
export async function ensureRemoteImage(
  target: SshTargetArgs,
  opts: EnsureRemoteImageOptions = {},
): Promise<EnsureRemoteImageResult> {
  const log = opts.onLog ?? ((): void => {});

  // An explicitly pinned ref is the user's problem to keep present — we neither
  // pull nor build it, because we have no idea what it contains.
  if (opts.imageRef && opts.imageRef.trim().length > 0) {
    const ref = opts.imageRef.trim();
    const probe = await dockerOnRemote(target, ['image', 'inspect', ref]);
    if (probe.exitCode !== 0) {
      throw new Error(
        `remote-docker: box.imageRemoteDocker pins "${ref}", which is not present on the remote engine. ` +
          `Build/pull it there, or unset the key to let AgentBox manage the image.`,
      );
    }
    return { ref, source: 'pinned' };
  }

  const sha = await currentContextSha(opts.agentInstall);
  if (!sha) {
    throw new Error(
      'remote-docker: cannot resolve the box build context (a dev tree needs `pnpm -w build` first)',
    );
  }
  const ref = remoteImageRef(sha);

  if (!opts.force) {
    const probe = await dockerOnRemote(target, ['image', 'inspect', ref]);
    if (probe.exitCode === 0) {
      log(`[image] ${ref} already present on the remote`);
      return { ref, source: 'present', contextSha256: sha };
    }
  }

  const registry = opts.registry ?? BOX_IMAGE_REGISTRY;
  if (opts.allowPull !== false && registry) {
    const remote = registryRefForSha(sha, registry);
    log(`[image] pulling ${remote} on the remote engine`);
    const pull = await dockerOnRemote(target, ['pull', remote], {
      timeoutMs: 900_000,
      onLine: (l) => log(`[image] ${l}`),
    });
    if (pull.exitCode === 0) {
      await dockerOnRemote(target, ['tag', remote, ref]);
      log(`[image] pulled ${remote} -> ${ref}`);
      return { ref, source: 'pulled', contextSha256: sha };
    }
    log('[image] registry miss — building on the remote from the local context');
  }

  await buildOnRemote(target, ref, opts);
  return { ref, source: 'built', contextSha256: sha };
}

/**
 * The remote shell command that receives the streamed tar. Split out (with its
 * two siblings below) so the docker-29 contract — a directory context, never a
 * `-` stdin context alongside `-f` — is pinned by a pure unit test.
 */
export function stageContextCommand(remoteDir: string): string {
  const dir = quoteShellArg(remoteDir);
  return `mkdir -p ${dir} && tar -xf - -C ${dir}`;
}

/**
 * `docker build` argv for a context already staged at `remoteDir`.
 *
 * `-f` is ABSOLUTE on purpose: buildx resolves `--file` against the client's
 * working directory, not against the context (the classic builder resolved it
 * against the context, which is why a bare `Dockerfile.box` used to work). With
 * a login shell that cwd is the remote user's home, so a relative name fails
 * with `failed to read dockerfile: open Dockerfile.box: no such file`.
 */
export function remoteBuildArgv(
  ref: string,
  remoteDir: string,
  agentInstall?: ClaudeInstall,
): string[] {
  const argv = ['build', '-t', ref, '-f', `${remoteDir}/Dockerfile.box`];
  if (agentInstall) argv.push('--build-arg', `AGENTBOX_AGENT_INSTALL=${agentInstall}`);
  argv.push(remoteDir);
  return argv;
}

/** Remove a staged context, whatever the build did. */
export function cleanupContextCommand(remoteDir: string): string {
  return `rm -rf ${quoteShellArg(remoteDir)}`;
}

/**
 * Distinguishes two builds started inside the same millisecond — `Date.now()`
 * alone is not enough resolution for a fan-out that kicks several off at once.
 */
let contextSeq = 0;
function nextContextSeq(): number {
  contextSeq += 1;
  return contextSeq;
}

/**
 * Stream the local build context to the remote engine and build it there.
 *
 * The tar is unpacked into a remote temp dir and built as a **directory**
 * context. The older `docker build -` (tar on stdin) form is unusable from
 * docker 29 on: the classic builder is gone, and buildx refuses a stdin context
 * combined with `-f` — `ambiguous Dockerfile source: both stdin and flag
 * correspond to Dockerfiles`. Our context always names its Dockerfile
 * `Dockerfile.box`, so `-f` is not optional; the temp dir is. Nothing is left
 * behind: it is removed even when the build fails.
 */
async function buildOnRemote(
  target: SshTargetArgs,
  ref: string,
  opts: EnsureRemoteImageOptions,
): Promise<void> {
  const log = opts.onLog ?? ((): void => {});
  // One token for both ends, unique per invocation: two concurrent builds (two
  // laptops against one engine, or a bake racing a registry-miss create inside
  // the hub worker) must neither unpack into each other's remote context nor
  // share the local tar — the first to finish deletes it in its `finally` while
  // the other is still streaming from it.
  const token = `${String(process.pid)}-${String(Date.now())}-${String(nextContextSeq())}`;
  const tarPath = join(tmpdir(), `agentbox-box-ctx-${token}.tar`);
  const remoteDir = `/tmp/agentbox-box-ctx-${token}`;
  try {
    // COPYFILE_DISABLE stops macOS tar from emitting ._* AppleDouble entries,
    // which would land in the image as junk files.
    await execa('tar', ['-C', BUILD_CONTEXT_DIR, '-cf', tarPath, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });

    log(`[image] streaming the build context to ${remoteDir}`);
    const staged = await execa(
      'ssh',
      [...sshOptArgs(target), sshDestination(target), loginShell(stageContextCommand(remoteDir))],
      { reject: false, input: createReadStream(tarPath), stdout: 'pipe', stderr: 'pipe' },
    );
    if (staged.exitCode !== 0) {
      const err = typeof staged.stderr === 'string' ? staged.stderr.trim() : '';
      throw new Error(
        `remote-docker: could not stage the build context in ${remoteDir} (exit ${String(staged.exitCode)})${err ? `: ${err}` : ''}`,
      );
    }

    const buildArgs = remoteBuildArgv(ref, remoteDir, opts.agentInstall);

    log(`[image] building ${ref} on the remote`);
    const res = await dockerOnRemote(target, buildArgs, {
      timeoutMs: 1_800_000,
      onLine: (line) => {
        if (line.trim().length > 0) log(`[image] ${line}`);
      },
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `remote-docker: remote \`docker build\` failed (exit ${String(res.exitCode)}). See the build output above.`,
      );
    }
    log(`[image] built ${ref}`);
  } finally {
    await rm(tarPath, { force: true });
    // Best-effort: a leftover context dir is junk on someone else's disk, not a
    // reason to fail a build that otherwise succeeded.
    await execa(
      'ssh',
      [...sshOptArgs(target), sshDestination(target), loginShell(cleanupContextCommand(remoteDir))],
      { reject: false },
    ).catch(() => undefined);
  }
}
