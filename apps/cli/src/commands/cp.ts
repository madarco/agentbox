import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { log } from '@clack/prompts';
import { Command } from 'commander';
import { execa } from 'execa';
import { inspectBox, startBox, unpauseBox, type BoxRecord } from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';
import { requireDockerProvider } from './_provider-guard.js';

/**
 * A `<box>:<path>` arg has a `:` in it AND no `/` before that colon. Anything
 * starting with `./`, `/`, or `../` is unambiguously a host path. Box names
 * are kebab-case identifiers (validated at create), so they can't contain
 * `/`. Empty box ref or missing path → returns null and the caller errors out.
 */
function parseBoxArg(arg: string): { boxRef: string; path: string } | null {
  const idx = arg.indexOf(':');
  if (idx === -1) return null;
  const prefix = arg.slice(0, idx);
  if (prefix.includes('/')) return null;
  if (prefix.length === 0) return null;
  const p = arg.slice(idx + 1);
  if (p.length === 0) return null;
  return { boxRef: prefix, path: p };
}

interface Parsed {
  direction: 'download' | 'upload';
  boxRef: string;
  boxPath: string;
  hostPath: string | undefined; // undefined only on download with no dst (= cwd)
}

function parseArgs(src: string, dst: string | undefined): Parsed {
  const srcBox = parseBoxArg(src);
  const dstBox = dst === undefined ? null : parseBoxArg(dst);

  if (srcBox && dstBox) {
    throw new Error(
      'box-to-box copy is not supported; both arguments look like box paths (`name:/path`).',
    );
  }
  if (!srcBox && !dstBox) {
    throw new Error(
      'one argument must be a box path of the form `<box>:/path` (e.g. `mybox:/workspace/foo`).',
    );
  }
  if (srcBox) {
    return {
      direction: 'download',
      boxRef: srcBox.boxRef,
      boxPath: srcBox.path,
      hostPath: dst,
    };
  }
  if (dst === undefined) {
    throw new Error('host -> box copy requires a destination, e.g. `agentbox cp ./foo box:/dst`.');
  }
  return {
    direction: 'upload',
    boxRef: dstBox!.boxRef,
    boxPath: dstBox!.path,
    hostPath: src,
  };
}

/**
 * `docker cp` can't see through the `/workspace` overlay mount that AgentBox
 * boxes set up (the file lands in the image layer beneath the mount and is
 * invisible to the running container). All transfers go through `docker exec
 * tar`, which runs inside the container's mount namespace, so it sees mounts
 * the same way the in-box agent does.
 */

function posixDirname(p: string): string {
  return path.posix.dirname(p) || '/';
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

async function uploadToBox(
  box: BoxRecord,
  hostSrc: string,
  boxDst: string,
): Promise<{ finalPath: string; warn: string | null }> {
  const srcAbs = path.resolve(hostSrc);
  if (!existsSync(srcAbs)) throw new Error(`source not found: ${hostSrc}`);
  const srcBasename = path.basename(srcAbs);
  const srcParent = path.dirname(srcAbs);

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
      finalName = path.posix.basename(boxDst);
    }
  }
  const finalPath = boxParent === '/' ? `/${finalName}` : `${boxParent}/${finalName}`;

  // mkdir as root so the upload works for box paths outside the agent's
  // writable area (e.g. /etc/foo); chown at the end re-owns just the landed
  // path so we don't accidentally chown system dirs we mkdir'd through.
  const mk = await execa(
    'docker',
    ['exec', '--user', 'root', box.container, 'mkdir', '-p', boxParent],
    { reject: false },
  );
  if (mk.exitCode !== 0) {
    throw new Error(`mkdir -p ${boxParent} in box failed: ${asText(mk.stderr).slice(0, 300)}`);
  }

  // Buffer the host tar in memory and pipe as stdin to the in-box extract.
  // Same shape as `copyHostFilesToBox` in @agentbox/sandbox-docker — small
  // ad-hoc files are fine in RAM; tar handles directories recursively.
  // COPYFILE_DISABLE silences macOS BSD tar's `._*` resource-fork stubs that
  // would otherwise litter the box's filesystem on every upload.
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

  // Rename if the user asked for a different basename. Cheap shell mv,
  // avoids the GNU/BSD `--transform` syntax mismatch between hosts.
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

  // chown only the final path (file or directory) — anything we mkdir'd
  // above stays at its existing ownership.
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
  return { finalPath, warn: null };
}

async function downloadFromBox(
  box: BoxRecord,
  boxSrc: string,
  hostDst: string,
): Promise<{ finalPath: string }> {
  const srcBasename = path.posix.basename(boxSrc);
  const srcParent = posixDirname(boxSrc);

  const dstAbs = path.resolve(hostDst);
  let hostParent: string;
  let finalName: string;
  const dstExists = existsSync(dstAbs);
  if (hostDst.endsWith('/') || (dstExists && statSync(dstAbs).isDirectory())) {
    hostParent = dstAbs;
    finalName = srcBasename;
  } else {
    hostParent = path.dirname(dstAbs);
    finalName = path.basename(dstAbs);
  }
  mkdirSync(hostParent, { recursive: true });
  const finalPath = path.join(hostParent, finalName);

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
    renameSync(path.join(hostParent, srcBasename), finalPath);
  }
  return { finalPath };
}

export const cpCommand = new Command('cp')
  .description('Copy files between host and box (like `docker cp`; direction picked by `name:` prefix)')
  .argument('<src>', '`box:/path` (download) or host path (upload)')
  .argument(
    '[dst]',
    '`box:/path` (upload) or host path (download); defaults to cwd when downloading',
  )
  .addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  agentbox cp mybox:/etc/foo ./foo            # download (host path optional)',
      '  agentbox cp mybox:/workspace/.env           # download into cwd',
      '  agentbox cp ./local.txt mybox:/workspace/   # upload (host path required)',
      '  agentbox cp ./dir mybox:/workspace/         # upload directory (recursive)',
    ].join('\n'),
  )
  .action(async (src: string, dst: string | undefined) => {
    try {
      const parsed = parseArgs(src, dst);
      const box = await resolveBoxOrExit(parsed.boxRef);
      requireDockerProvider(box, 'cp');

      const insp = await inspectBox(box.id);
      if (insp.state === 'paused') {
        log.info('box is paused; unpausing');
        await unpauseBox(box.id);
      } else if (insp.state === 'stopped') {
        log.info('box is stopped; starting');
        await startBox(box.id);
      } else if (insp.state === 'missing') {
        throw new Error(`box ${box.name} has no container; was it destroyed?`);
      }

      if (parsed.direction === 'upload') {
        const result = await uploadToBox(box, parsed.hostPath!, parsed.boxPath);
        if (result.warn) {
          log.warn(`copied to ${box.name}:${result.finalPath}, but ${result.warn}`);
        } else {
          process.stdout.write(`copied to ${box.name}:${result.finalPath}\n`);
        }
      } else {
        // Download: default dst to cwd (POSIX `cp` convention).
        const result = await downloadFromBox(box, parsed.boxPath, parsed.hostPath ?? process.cwd());
        process.stdout.write(`copied to ${result.finalPath}\n`);
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
