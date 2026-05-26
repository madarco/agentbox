/**
 * Docker provider's symmetric host↔box file-copy primitives. Mirrors
 * `cloud-cp.ts` in `@agentbox/sandbox-cloud` so both providers expose the same
 * `uploadPath` / `downloadPath` capability.
 *
 * `docker cp` can't see through the `/workspace` overlay mount AgentBox boxes
 * set up (the file lands in the image layer beneath the mount and is invisible
 * to the running container). Everything goes through `docker exec tar`, which
 * runs inside the container's mount namespace — same mounts the in-box agent
 * sees.
 */

import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, posix, resolve } from 'node:path';
import { execa } from 'execa';
import type { BoxRecord } from '@agentbox/core';

function posixDirname(p: string): string {
  return posix.dirname(p) || '/';
}

/**
 * `execa({ encoding: 'buffer' })` returns stderr as a `Buffer`; `String(buf)`
 * on Node 20+ stringifies it as a comma-joined byte list, so error messages
 * come out as e.g. `116,97,114,…` instead of text. Decode explicitly.
 */
function asText(s: string | Uint8Array | undefined): string {
  if (s === undefined) return '';
  if (typeof s === 'string') return s;
  return Buffer.from(s).toString('utf8');
}

export interface BoxCpResult {
  finalPath: string;
  /** Non-fatal warning the caller may want to surface (e.g. chown failed). */
  warn?: string;
}

export async function uploadToBox(
  box: BoxRecord,
  hostSrc: string,
  boxDst: string,
): Promise<BoxCpResult> {
  const srcAbs = resolve(hostSrc);
  if (!existsSync(srcAbs)) throw new Error(`source not found: ${hostSrc}`);
  const srcBasename = basename(srcAbs);
  const srcParent = dirname(srcAbs);

  // Decide box parent dir + final name (docker cp semantics):
  // - trailing `/` → dst is a directory; src lands as <dst>/<srcBasename>
  // - dst exists as a dir in box → same
  // - else dst is the full target path; rename during extraction
  let boxParent: string;
  let finalName: string;
  if (boxDst.endsWith('/')) {
    boxParent = boxDst.replace(/\/+$/, '') || '/';
    finalName = srcBasename;
  } else {
    const isDir = await execa(
      'docker',
      ['exec', box.container, 'test', '-d', boxDst],
      { reject: false },
    );
    if (isDir.exitCode === 0) {
      boxParent = boxDst.replace(/\/+$/, '') || '/';
      finalName = srcBasename;
    } else {
      boxParent = posixDirname(boxDst);
      finalName = posix.basename(boxDst);
    }
  }
  const finalPath = boxParent === '/' ? `/${finalName}` : `${boxParent}/${finalName}`;

  const mk = await execa(
    'docker',
    ['exec', '--user', 'root', box.container, 'mkdir', '-p', boxParent],
    { reject: false },
  );
  if (mk.exitCode !== 0) {
    throw new Error(`mkdir -p ${boxParent} in box failed: ${asText(mk.stderr).slice(0, 300)}`);
  }

  // COPYFILE_DISABLE silences macOS BSD tar's `._*` resource-fork stubs.
  const packed = await execa('tar', ['-C', srcParent, '-cf', '-', srcBasename], {
    encoding: 'buffer',
    reject: false,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (packed.exitCode !== 0) {
    throw new Error(`tar pack failed: ${asText(packed.stderr).slice(0, 300)}`);
  }
  const extract = await execa(
    'docker',
    ['exec', '-i', '--user', 'root', box.container, 'tar', '-xf', '-', '-C', boxParent],
    { input: packed.stdout as Buffer, reject: false },
  );
  if (extract.exitCode !== 0) {
    throw new Error(`tar extract in box failed: ${asText(extract.stderr).slice(0, 300)}`);
  }

  if (finalName !== srcBasename) {
    const initial = boxParent === '/' ? `/${srcBasename}` : `${boxParent}/${srcBasename}`;
    const mv = await execa(
      'docker',
      ['exec', '--user', 'root', box.container, 'mv', initial, finalPath],
      { reject: false },
    );
    if (mv.exitCode !== 0) {
      throw new Error(
        `rename ${initial} -> ${finalPath} in box failed: ${asText(mv.stderr).slice(0, 300)}`,
      );
    }
  }

  const chown = await execa(
    'docker',
    ['exec', '--user', 'root', box.container, 'chown', '-R', '1000:1000', finalPath],
    { reject: false },
  );
  if (chown.exitCode !== 0) {
    return {
      finalPath,
      warn: `chown ${finalPath} to vscode (uid 1000) failed; ownership inside the box may be root.`,
    };
  }
  return { finalPath };
}

export async function downloadFromBox(
  box: BoxRecord,
  boxSrc: string,
  hostDst: string,
): Promise<BoxCpResult> {
  const srcBasename = posix.basename(boxSrc);
  const srcParent = posixDirname(boxSrc);

  const dstAbs = resolve(hostDst);
  let hostParent: string;
  let finalName: string;
  const dstExists = existsSync(dstAbs);
  if (hostDst.endsWith('/') || (dstExists && statSync(dstAbs).isDirectory())) {
    hostParent = dstAbs;
    finalName = srcBasename;
  } else {
    hostParent = dirname(dstAbs);
    finalName = basename(dstAbs);
  }
  mkdirSync(hostParent, { recursive: true });
  const finalPath = posix.join(hostParent, finalName);

  const packed = await execa(
    'docker',
    ['exec', box.container, 'tar', '-C', srcParent, '-cf', '-', srcBasename],
    { encoding: 'buffer', reject: false },
  );
  if (packed.exitCode !== 0) {
    throw new Error(`tar pack in box failed: ${asText(packed.stderr).slice(0, 300)}`);
  }
  const extract = await execa('tar', ['-xf', '-', '-C', hostParent], {
    input: packed.stdout as Buffer,
    reject: false,
  });
  if (extract.exitCode !== 0) {
    throw new Error(`tar extract on host failed: ${asText(extract.stderr).slice(0, 300)}`);
  }

  if (finalName !== srcBasename) {
    renameSync(posix.join(hostParent, srcBasename), finalPath);
  }
  return { finalPath };
}
