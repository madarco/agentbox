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

/** In-box home for the agent user; boxes always run as `vscode` (uid 1000). */
const BOX_HOME = '/home/vscode';

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

/** `--exclude=<pat>` args for each tar pattern (already expanded by the caller). */
function tarExcludeArgs(exclude: string[] | undefined): string[] {
  return (exclude ?? []).map((p) => `--exclude=${p}`);
}

/**
 * Stream a tar producer into a tar consumer without buffering. execa buffers
 * each subprocess' stdout into memory by default and caps it at 100 MB
 * (`maxBuffer`), which silently kills the producer ("tar: Write error") on any
 * sizable copy — so we disable stdout buffering on the producer and pipe the
 * raw stream into the consumer's stdin. stderr stays buffered for diagnostics.
 * Returns both results; callers check exit codes producer-first.
 */
interface ProcOutcome {
  exitCode: number | undefined;
  stderr: string | Uint8Array | undefined;
}

export async function streamTarPipe(
  producerFile: string,
  producerArgs: string[],
  consumerFile: string,
  consumerArgs: string[],
  producerEnv?: NodeJS.ProcessEnv,
): Promise<[ProcOutcome, ProcOutcome]> {
  const producer = execa(producerFile, producerArgs, {
    reject: false,
    buffer: { stdout: false },
    ...(producerEnv ? { env: producerEnv } : {}),
  });
  const consumer = execa(consumerFile, consumerArgs, {
    reject: false,
    buffer: { stdout: false },
  });
  producer.stdout?.pipe(consumer.stdin!);
  const [p, c] = await Promise.all([producer, consumer]);
  return [
    { exitCode: p.exitCode, stderr: p.stderr },
    { exitCode: c.exitCode, stderr: c.stderr },
  ];
}

export async function uploadToBox(
  box: BoxRecord,
  hostSrc: string,
  boxDst: string,
  exclude?: string[],
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

  // Stream the tarball straight from host `tar` into the box's `tar -xf -`
  // instead of buffering it (see streamTarPipe — execa's 100 MB maxBuffer
  // otherwise silently fails large copies with "tar: Write error").
  // COPYFILE_DISABLE silences macOS BSD tar's `._*` resource-fork stubs.
  const [packed, extracted] = await streamTarPipe(
    'tar',
    ['-C', srcParent, '-cf', '-', ...tarExcludeArgs(exclude), srcBasename],
    'docker',
    ['exec', '-i', '--user', 'root', box.container, 'tar', '-xf', '-', '-C', boxParent],
    { ...process.env, COPYFILE_DISABLE: '1' },
  );
  if (packed.exitCode !== 0) {
    throw new Error(`tar pack failed: ${asText(packed.stderr).slice(0, 300)}`);
  }
  if (extracted.exitCode !== 0) {
    throw new Error(`tar extract in box failed: ${asText(extracted.stderr).slice(0, 300)}`);
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

  // Parent-chain chown: `mkdir -p` ran as root, so any new dirs between $HOME
  // and the landed path are root-owned. When the dest is under the box home,
  // walk back up to $HOME (exclusive) and chown each so the agent (vscode) can
  // write siblings — e.g. session-teleport lands a rollout under
  // `~/.codex/sessions/YYYY/MM/DD/` and Codex must then create its
  // `state_*.sqlite` index in that subtree. Non-fatal (matches the warn-only
  // policy of the chown above).
  // Strictly *under* home (trailing segment) — never `=== BOX_HOME`, else the
  // walk's `dirname` would be `/home` and could reassign `/home` itself.
  if (finalPath.startsWith(BOX_HOME + '/')) {
    const walk = await execa(
      'docker',
      [
        'exec',
        '--user',
        'root',
        box.container,
        'sh',
        '-c',
        `parent=$(dirname "$1"); ` +
          `while [ "$parent" != "$2" ] && [ "$parent" != "/" ]; do ` +
          `chown 1000:1000 "$parent" || true; ` +
          `parent=$(dirname "$parent"); ` +
          `done`,
        'sh',
        finalPath,
        BOX_HOME,
      ],
      { reject: false },
    );
    if (walk.exitCode !== 0) {
      return {
        finalPath,
        warn: `chown of parent dirs under ${BOX_HOME} failed; some may remain root-owned.`,
      };
    }
  }
  return { finalPath };
}

export async function downloadFromBox(
  box: BoxRecord,
  boxSrc: string,
  hostDst: string,
  exclude?: string[],
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

  // Stream box `tar` → host `tar -xf -` (see streamTarPipe for why we don't buffer).
  const [packed, extracted] = await streamTarPipe(
    'docker',
    ['exec', box.container, 'tar', '-C', srcParent, '-cf', '-', ...tarExcludeArgs(exclude), srcBasename],
    'tar',
    ['-xf', '-', '-C', hostParent],
  );
  if (packed.exitCode !== 0) {
    throw new Error(`tar pack in box failed: ${asText(packed.stderr).slice(0, 300)}`);
  }
  if (extracted.exitCode !== 0) {
    throw new Error(`tar extract on host failed: ${asText(extracted.stderr).slice(0, 300)}`);
  }

  if (finalName !== srcBasename) {
    renameSync(posix.join(hostParent, srcBasename), finalPath);
  }
  return { finalPath };
}
