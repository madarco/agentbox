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
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
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

/** In-box home for the agent user; cloud boxes always run as `vscode`. */
const BOX_HOME = '/home/vscode';

export interface CloudCpResult {
  /** Final landed path on the receiving side. */
  finalPath: string;
}

async function uploadOneToCloudBox(
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

  // Where it lands, per docker cp rules (see file header). The box-side script
  // also treats an EXISTING directory as one, trailing slash or not: `cp
  // fromHost ./README.md .` from a subfolder used to read `.` as a target FILE
  // path, unpack README.md over `/workspace/README.md`, move it into the
  // subfolder and delete the original.
  const trailing = boxDst.endsWith('/');
  const dstNoSlash = boxDst.replace(/\/+$/, '') || '/';

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

    // Sudo for the dir ops because the destination may be outside the user's
    // writable area (e.g. /etc/foo); devcontainers/base grants vscode
    // passwordless sudo and the SUDO=:'' fallback makes it a no-op when
    // sudo isn't available (test sandboxes).
    //
    // The payload is unpacked into a PRIVATE staging dir and copied from
    // there to the final path, so nothing beside the destination is ever
    // overwritten or deleted. (`cp`, not `mv`: Daytona's S3-backed FUSE
    // volumes return ENOSYS for rename(2) across the mount boundary.)
    //
    // Parent-chain chown: `mkdir -p` ran as root (via $SUDO), so any new dirs
    // between $HOME and the landed path are root-owned. When the dest is under
    // the box home, walk back up to $HOME (exclusive) and chown each so the
    // agent (vscode) can write siblings — e.g. session-teleport lands a rollout
    // under `~/.codex/sessions/YYYY/MM/DD/` and Codex must then create its
    // `state_*.sqlite` index in that subtree. System paths (/etc/*) and
    // /workspace keep their existing ownership. The whole script runs via
    // `bashScript()` (`bash -c '<body>'`), which protects `$(...)`/`while` from
    // Vercel's outer `sudo -u vscode -H bash -lc` wrapping. Strictly *under*
    // home — never `= $HOME`, else `dirname` would reach `/home` itself.
    const script = [
      `set -euo pipefail`,
      `if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi`,
      `dst=${quoteShellArg(dstNoSlash)}`,
      `base=${quoteShellArg(srcBasename)}`,
      trailing
        ? `parent="$dst"; final="\${dst%/}/$base"`
        : `if [ -d "$dst" ]; then parent="$dst"; final="\${dst%/}/$base"; else parent=$(dirname "$dst"); final="$dst"; fi`,
      `stage=$(mktemp -d /tmp/agentbox-cp-stage.XXXXXX)`,
      `trap 'rm -rf "$stage"' EXIT`,
      // --no-same-permissions / --no-same-owner / -m: Daytona's S3-backed
      // FUSE volumes reject chmod/utime/chown; skipping them lets the extract
      // complete on a mounted-volume destination.
      `tar -xzf ${quoteShellArg(REMOTE_UP_TAR)} -C "$stage" --no-same-permissions --no-same-owner -m`,
      `$SUDO mkdir -p "$parent"`,
      `if [ -d "$stage/$base" ]; then $SUDO mkdir -p "$final" && $SUDO cp -a "$stage/$base/." "$final/"; else $SUDO cp -f "$stage/$base" "$final"; fi`,
      // chown the landed subtree, then the parent chain back up to $HOME.
      // Tolerate failure (chown bad on read-only / FUSE mounts).
      `$SUDO chown -R "$(id -un):$(id -gn)" "$final" || true`,
      `case "$final" in ${quoteShellArg(BOX_HOME)}/*) ` +
        `p=$(dirname "$final"); ` +
        `while [ "$p" != ${quoteShellArg(BOX_HOME)} ] && [ "$p" != "/" ]; do ` +
        `$SUDO chown "$(id -un):$(id -gn)" "$p" || true; p=$(dirname "$p"); done;; ` +
        `esac`,
      `rm -f ${quoteShellArg(REMOTE_UP_TAR)}`,
      `printf '%s\\n' "__AGENTBOX_CP_FINAL__=$final"`,
    ].join('\n');
    const r = await backend.exec(handle, bashScript(script));
    if (r.exitCode !== 0) {
      throw new Error(`cloud upload extract failed: ${r.stderr || r.stdout}`);
    }
    const landed = /__AGENTBOX_CP_FINAL__=(.*)$/m.exec(r.stdout ?? '')?.[1]?.trim();
    return {
      finalPath: landed || (trailing ? posix.join(dstNoSlash, srcBasename) : dstNoSlash),
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
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
    //
    // NEVER a `.git` (any depth): this is the workspace download, and the box's
    // repo metadata unpacked over the PC's project would replace its config,
    // HEAD, index and refs (a hub box's clone is even shallow), and could plant
    // hooks. The box's commits reach the PC through git (push / `--host-only`),
    // not through a file copy. Excluded on both ends: the box never packs it,
    // and the host never unpacks one.
    const packScript = [
      `set -euo pipefail`,
      `cd ${quoteShellArg(boxSrcDir)}`,
      `tar -czf ${quoteShellArg(REMOTE_DOWN_TAR)} --exclude=.git .`,
    ].join('\n');
    const r = await backend.exec(handle, bashScript(packScript));
    if (r.exitCode !== 0) {
      throw new Error(`cloud workspace pack failed: ${r.stderr || r.stdout}`);
    }
    await backend.downloadFile(handle, REMOTE_DOWN_TAR, localTar);
    await execa('tar', ['-xzf', localTar, '-C', dstAbs, '--exclude=.git']);
    await backend.exec(handle, `rm -f ${quoteShellArg(REMOTE_DOWN_TAR)}`).catch(() => {
      /* best-effort */
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { finalPath: dstAbs };
}

async function downloadOneFromCloudBox(
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
    const excludeArgs = (exclude ?? []).map((p) => `--exclude=${quoteShellArg(p)}`).join(' ');
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
    // Unpacked into the private stage, then copied to the final path: an
    // extract straight into `hostParent` would overwrite a file of the
    // source's name there, and the rename to `finalPath` would then remove it.
    const unpacked = hostJoin(stage, 'out');
    mkdirSync(unpacked);
    await execa('tar', ['-xzf', localTar, '-C', unpacked]);
    cpSync(hostJoin(unpacked, srcBasename), finalPath, { recursive: true, force: true });
    // Best-effort cleanup; tolerate failure (sandbox may have ephemeral /tmp).
    await backend.exec(handle, `rm -f ${quoteShellArg(REMOTE_DOWN_TAR)}`).catch(() => {
      /* best-effort */
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { finalPath };
}

/**
 * Copy one or more host sources into the cloud box. A single source keeps full
 * `docker cp` semantics; ≥2 sources land under a destination directory (the
 * cloud path has no in-box `test -d` probe, so the dir is opted into with a
 * trailing `/`). The single-source primitive is run once per source, serially —
 * `REMOTE_UP_TAR` is a fixed remote staging path reused each iteration.
 */
export async function uploadToCloudBox(
  backend: CloudBackend,
  handle: CloudHandle,
  hostSrcs: string[],
  boxDst: string,
  exclude?: string[],
): Promise<CloudCpResult> {
  if (hostSrcs.length === 1) {
    return uploadOneToCloudBox(backend, handle, hostSrcs[0]!, boxDst, exclude);
  }
  if (!boxDst.endsWith('/')) {
    throw new Error(
      `cannot copy multiple sources to '${boxDst}': destination is not a directory (add a trailing slash, e.g. ${boxDst}/)`,
    );
  }
  for (const src of hostSrcs) {
    await uploadOneToCloudBox(backend, handle, src, boxDst, exclude);
  }
  return { finalPath: boxDst };
}

/**
 * Copy one or more box sources to the host. A single source keeps full
 * `docker cp` semantics; ≥2 sources land under a destination directory. Run
 * serially — `REMOTE_DOWN_TAR` is a fixed remote staging path reused each
 * iteration.
 */
export async function downloadFromCloudBox(
  backend: CloudBackend,
  handle: CloudHandle,
  boxSrcs: string[],
  hostDst: string,
  exclude?: string[],
): Promise<CloudCpResult> {
  if (boxSrcs.length === 1) {
    return downloadOneFromCloudBox(backend, handle, boxSrcs[0]!, hostDst, exclude);
  }
  const dstAbs = hostResolve(hostDst);
  const dstExists = existsSync(dstAbs);
  if (!hostDst.endsWith('/') && !(dstExists && statSync(dstAbs).isDirectory())) {
    throw new Error(
      `cannot copy multiple sources to '${hostDst}': destination is not a directory (add a trailing slash, e.g. ${hostDst}/)`,
    );
  }
  mkdirSync(dstAbs, { recursive: true });
  for (const src of boxSrcs) {
    await downloadOneFromCloudBox(backend, handle, src, dstAbs, exclude);
  }
  return { finalPath: dstAbs };
}
