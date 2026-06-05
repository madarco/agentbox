/**
 * `cp`-style file transfer for cloud boxes — symmetric host↔box uploads and
 * downloads that mirror `docker cp` semantics. The Docker provider tar-pipes
 * over `docker exec`; clouds with no exec stream can't, so we stage to a
 * single tar file in `/tmp`, transfer it via `backend.uploadFile` /
 * `downloadFile`, and unpack on the other side. Handles files and
 * directories uniformly.
 *
 * Path semantics match `docker cp`'s pragmatic subset: trailing `/` on the
 * destination means "treat as a directory, land the source under it"; no
 * trailing `/` means "destination is the full target path" (rename during
 * extraction). The in-box `test -d` probe the Docker provider uses to detect
 * existing directories isn't replicated here — it'd cost an extra exec
 * round-trip per call and the trailing-`/` convention is the explicit form
 * anyway.
 */

import { execa } from 'execa';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename as hostBasename,
  dirname as hostDirname,
  join as hostJoin,
  resolve as hostResolve,
} from 'node:path';
import { posix } from 'node:path';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { bashScript, quoteShellArg } from './shell.js';

const REMOTE_UP_TAR = '/tmp/agentbox-cp-up.tar.gz';
const REMOTE_DOWN_TAR = '/tmp/agentbox-cp-down.tar.gz';

export interface CloudCpResult {
  /** Final landed path on the receiving side. */
  finalPath: string;
}

export async function uploadToCloudBox(
  backend: CloudBackend,
  handle: CloudHandle,
  hostSrc: string,
  boxDst: string,
  exclude?: string[],
): Promise<CloudCpResult> {
  const srcAbs = hostResolve(hostSrc);
  if (!existsSync(srcAbs)) throw new Error(`source not found: ${hostSrc}`);
  const srcBasename = hostBasename(srcAbs);
  const srcParent = hostDirname(srcAbs);

  // Resolve `boxParent` + final filename per docker cp rules — see file
  // header. We can't probe `test -d` cheaply, so the user opts into the
  // dir-vs-file ambiguity with the trailing slash.
  let boxParent: string;
  let finalName: string;
  if (boxDst.endsWith('/')) {
    boxParent = boxDst.replace(/\/+$/, '') || '/';
    finalName = srcBasename;
  } else {
    boxParent = posix.dirname(boxDst);
    finalName = posix.basename(boxDst);
  }
  const finalPath = boxParent === '/' ? `/${finalName}` : `${boxParent}/${finalName}`;

  const stage = await mkdtemp(hostJoin(tmpdir(), 'agentbox-cp-up-'));
  const localTar = hostJoin(stage, 'payload.tar.gz');
  try {
    // COPYFILE_DISABLE silences macOS BSD tar's `._*` resource-fork stubs
    // that would otherwise litter the box's filesystem on every upload.
    const excludeArgs = (exclude ?? []).map((p) => `--exclude=${p}`);
    await execa('tar', ['-C', srcParent, '-czf', localTar, ...excludeArgs, srcBasename], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    await backend.uploadFile(handle, localTar, REMOTE_UP_TAR);

    // Sudo for the dir ops because `boxParent` may be outside the user's
    // writable area (e.g. /etc/foo); devcontainers/base grants vscode
    // passwordless sudo and the SUDO=:'' fallback makes it a no-op when
    // sudo isn't available (test sandboxes).
    const initialPath = boxParent === '/' ? `/${srcBasename}` : `${boxParent}/${srcBasename}`;
    // Daytona's S3-backed FUSE volumes return ENOSYS for rename(2), so `mv`
    // fails when the destination crosses the mount boundary. `cp -f` + `rm`
    // works on every backend (and on the regular sandbox disk is no slower
    // than mv for a single file).
    const renameStep =
      finalName !== srcBasename
        ? `$SUDO cp -f ${quoteShellArg(initialPath)} ${quoteShellArg(finalPath)} && $SUDO rm -f ${quoteShellArg(initialPath)}`
        : ': # no rename';
    const script = [
      `set -euo pipefail`,
      `if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi`,
      `$SUDO mkdir -p ${quoteShellArg(boxParent)}`,
      // --no-same-permissions / --no-same-owner / -m: Daytona's S3-backed
      // FUSE volumes reject chmod/utime/chown; skipping them lets the extract
      // complete on a mounted-volume destination. Harmless no-op on the
      // sandbox's regular disk. Same flags as the credential-seed extract.
      `$SUDO tar -xzf ${quoteShellArg(REMOTE_UP_TAR)} -C ${quoteShellArg(boxParent)} --no-same-permissions --no-same-owner -m`,
      renameStep,
      // chown only the landed path — anything we mkdir'd through stays at
      // its existing ownership. Tolerate failure (chown bad on read-only mounts).
      `$SUDO chown -R "$(id -un):$(id -gn)" ${quoteShellArg(finalPath)} || true`,
      `rm -f ${quoteShellArg(REMOTE_UP_TAR)}`,
    ].join('\n');
    const r = await backend.exec(handle, bashScript(script));
    if (r.exitCode !== 0) {
      throw new Error(`cloud upload extract failed: ${r.stderr || r.stdout}`);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { finalPath };
}

/**
 * Pull the *contents* of an in-sandbox directory into a host directory —
 * `/workspace/*` → `<hostDst>/*`, not `<hostDst>/<srcBasename>/*`. Used by
 * `agentbox download` (the bulk workspace pull); `downloadFromCloudBox`
 * preserves the source basename for `docker cp` parity.
 */
export async function pullCloudDirContents(
  backend: CloudBackend,
  handle: CloudHandle,
  boxSrcDir: string,
  hostDstDir: string,
): Promise<CloudCpResult> {
  const dstAbs = hostResolve(hostDstDir);
  mkdirSync(dstAbs, { recursive: true });

  const stage = await mkdtemp(hostJoin(tmpdir(), 'agentbox-pull-'));
  const localTar = hostJoin(stage, 'payload.tar.gz');
  try {
    // `tar -C <dir> -czf <tarball> .` packs the contents (no leading
    // basename component) so extraction lands them in dstAbs directly.
    const packScript = [
      `set -euo pipefail`,
      `cd ${quoteShellArg(boxSrcDir)}`,
      `tar -czf ${quoteShellArg(REMOTE_DOWN_TAR)} .`,
    ].join('\n');
    const r = await backend.exec(handle, bashScript(packScript));
    if (r.exitCode !== 0) {
      throw new Error(`cloud workspace pack failed: ${r.stderr || r.stdout}`);
    }
    await backend.downloadFile(handle, REMOTE_DOWN_TAR, localTar);
    await execa('tar', ['-xzf', localTar, '-C', dstAbs]);
    await backend
      .exec(handle, `rm -f ${quoteShellArg(REMOTE_DOWN_TAR)}`)
      .catch(() => {
        /* best-effort */
      });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { finalPath: dstAbs };
}

export async function downloadFromCloudBox(
  backend: CloudBackend,
  handle: CloudHandle,
  boxSrc: string,
  hostDst: string,
  exclude?: string[],
): Promise<CloudCpResult> {
  const srcBasename = posix.basename(boxSrc);
  const srcParent = posix.dirname(boxSrc);

  const dstAbs = hostResolve(hostDst);
  let hostParent: string;
  let finalName: string;
  const dstExists = existsSync(dstAbs);
  if (hostDst.endsWith('/') || (dstExists && statSync(dstAbs).isDirectory())) {
    hostParent = dstAbs;
    finalName = srcBasename;
  } else {
    hostParent = hostDirname(dstAbs);
    finalName = hostBasename(dstAbs);
  }
  mkdirSync(hostParent, { recursive: true });
  const finalPath = hostJoin(hostParent, finalName);

  const stage = await mkdtemp(hostJoin(tmpdir(), 'agentbox-cp-down-'));
  const localTar = hostJoin(stage, 'payload.tar.gz');
  try {
    const excludeArgs = (exclude ?? [])
      .map((p) => `--exclude=${quoteShellArg(p)}`)
      .join(' ');
    const packScript = [
      `set -euo pipefail`,
      `cd ${quoteShellArg(srcParent)}`,
      `tar -czf ${quoteShellArg(REMOTE_DOWN_TAR)} ${excludeArgs} ${quoteShellArg(srcBasename)}`,
    ].join('\n');
    const r = await backend.exec(handle, bashScript(packScript));
    if (r.exitCode !== 0) {
      throw new Error(`cloud download pack failed: ${r.stderr || r.stdout}`);
    }
    await backend.downloadFile(handle, REMOTE_DOWN_TAR, localTar);
    await execa('tar', ['-xzf', localTar, '-C', hostParent]);
    if (finalName !== srcBasename) {
      renameSync(hostJoin(hostParent, srcBasename), finalPath);
    }
    // Best-effort cleanup; tolerate failure (sandbox may have ephemeral /tmp).
    await backend
      .exec(handle, `rm -f ${quoteShellArg(REMOTE_DOWN_TAR)}`)
      .catch(() => {
        /* best-effort */
      });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { finalPath };
}
