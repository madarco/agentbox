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
 * is arm64) → stream the local build context to a remote `docker build -`.
 */

import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { quoteShellArgv } from '@agentbox/sandbox-cloud';
import {
  BOX_IMAGE_REGISTRY,
  BUILD_CONTEXT_DIR,
  computeDockerContextFingerprint,
  registryRefForSha,
} from '@agentbox/sandbox-docker';
import {
  claudeInstallFingerprint,
  sshDestination,
  sshOptArgs,
  type SshTargetArgs,
} from '@agentbox/sandbox-core';
import { dockerOnRemote, loginShell } from './remote-docker.js';

export type ClaudeInstall = 'native' | 'npm';

export interface EnsureRemoteImageOptions {
  /** Pin an explicit image ref on the remote (`box.imageRemoteDocker`); skips the ensure. */
  imageRef?: string;
  claudeInstall?: ClaudeInstall;
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
export async function currentContextSha(claudeInstall?: ClaudeInstall): Promise<string | null> {
  const fp = await computeDockerContextFingerprint({});
  if (!fp) return null;
  return claudeInstall
    ? claudeInstallFingerprint(fp.contextSha256, claudeInstall)
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

  const sha = await currentContextSha(opts.claudeInstall);
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
 * Stream the local build context to `docker build -` on the remote.
 *
 * `docker build -` reads a tar of the context from stdin, so the whole build
 * happens on the remote engine with no files staged on its disk beforehand —
 * and no dependency on the remote having a checkout of anything.
 */
async function buildOnRemote(
  target: SshTargetArgs,
  ref: string,
  opts: EnsureRemoteImageOptions,
): Promise<void> {
  const log = opts.onLog ?? ((): void => {});
  const tarPath = join(tmpdir(), `agentbox-box-ctx-${String(process.pid)}.tar`);
  try {
    // COPYFILE_DISABLE stops macOS tar from emitting ._* AppleDouble entries,
    // which would land in the image as junk files.
    await execa('tar', ['-C', BUILD_CONTEXT_DIR, '-cf', tarPath, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });

    const buildArgs = ['build', '-t', ref, '-f', 'Dockerfile.box'];
    if (opts.claudeInstall) {
      buildArgs.push('--build-arg', `AGENTBOX_CLAUDE_INSTALL=${opts.claudeInstall}`);
    }
    buildArgs.push('-');

    log(`[image] building ${ref} on the remote (streaming the build context)`);
    const res = await execa(
      'ssh',
      [
        ...sshOptArgs(target),
        sshDestination(target),
        loginShell(`docker ${quoteShellArgv(buildArgs)}`),
      ],
      { reject: false, input: createReadStream(tarPath), stdout: 'pipe', stderr: 'pipe' },
    );
    const out = `${typeof res.stdout === 'string' ? res.stdout : ''}${typeof res.stderr === 'string' ? res.stderr : ''}`;
    for (const line of out.split(/\r?\n/)) {
      if (line.trim().length > 0) log(`[image] ${line}`);
    }
    if (res.exitCode !== 0) {
      throw new Error(
        `remote-docker: remote \`docker build\` failed (exit ${String(res.exitCode)}). See the build output above.`,
      );
    }
    log(`[image] built ${ref}`);
  } finally {
    await rm(tarPath, { force: true });
  }
}
