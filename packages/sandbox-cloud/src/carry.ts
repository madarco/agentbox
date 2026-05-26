/**
 * Apply the `carry:` block from `agentbox.yaml` against a cloud sandbox.
 *
 * Mirror of `copyCarryPathsToBox` in `@agentbox/sandbox-docker`: per-entry tar
 * upload + extract, with destinations that may live anywhere in the box
 * (not constrained to /workspace). Runs after `uploadEnvFiles` and before the
 * supervisor launches, so the first declared task sees the carry files
 * already in place.
 *
 * Best-effort per-entry: a single failed entry is recorded in `errors` and
 * the function returns — the box stays usable; the caller logs the misses.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { CloudBackend, CloudHandle, ResolvedCarryEntry } from '@agentbox/core';

export interface UploadCarryArgs {
  backend: CloudBackend;
  handle: CloudHandle;
  entries: ResolvedCarryEntry[];
  onLog?: (line: string) => void;
}

export interface UploadCarryResult {
  copied: number;
  errors: string[];
  /** Audit summary for BoxRecord.carry. */
  applied: Array<{ src: string; dest: string; bytes: number }>;
}

/** Hardcoded in-box home; cloud boxes always run as the `vscode` user. */
const BOX_HOME = '/home/vscode';

export async function uploadCarryPaths(args: UploadCarryArgs): Promise<UploadCarryResult> {
  const log = args.onLog ?? (() => {});
  if (args.entries.length === 0) {
    return { copied: 0, errors: [], applied: [] };
  }

  const stage = await mkdtemp(join(tmpdir(), 'agentbox-carry-'));
  const errors: string[] = [];
  const applied: UploadCarryResult['applied'] = [];
  let copied = 0;

  try {
    for (const [i, entry] of args.entries.entries()) {
      const where = `carry[${String(i)}] "${entry.rawSrc}"`;
      if (entry.kind === 'missing') {
        log(`${where}: skipped (missing on host, optional)`);
        continue;
      }
      try {
        await uploadOneEntry({
          backend: args.backend,
          handle: args.handle,
          entry,
          stageDir: stage,
          index: i,
        });
        copied += 1;
        applied.push({ src: entry.absSrc, dest: entry.absDest, bytes: entry.bytes ?? 0 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${where}: ${msg}`);
        log(`${where}: failed: ${msg}`);
      }
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  return { copied, errors, applied };
}

interface UploadOneArgs {
  backend: CloudBackend;
  handle: CloudHandle;
  entry: ResolvedCarryEntry;
  stageDir: string;
  index: number;
}

async function uploadOneEntry(args: UploadOneArgs): Promise<void> {
  const { entry } = args;
  if (entry.kind === 'missing') return;

  // ~/ → /home/vscode at this layer (host-side). Never expanded inside the box
  // because the supervisor user's $HOME equals BOX_HOME, but the exec shell's
  // current user (the SDK's default) is not guaranteed to be vscode on every
  // backend — expanding here makes the destination path explicit.
  const boxDest = entry.absDest.startsWith('~/')
    ? `${BOX_HOME}/${entry.absDest.slice(2)}`
    : entry.absDest;

  const isDir = entry.kind === 'dir';
  const parentDir = isDir ? boxDest : dirnameUnix(boxDest);

  // 1. Tar the host source on disk so backend.uploadFile (which takes a path,
  //    not a stream) has something to send.
  const localTar = join(args.stageDir, `carry-${String(args.index)}.tar`);
  const tarArgs = isDir
    ? ['-C', entry.absSrc, '-cf', localTar, '.']
    : ['-C', dirnameUnix(entry.absSrc), '-cf', localTar, basenameUnix(entry.absSrc)];
  const packed = await execa('tar', tarArgs, { reject: false });
  if (packed.exitCode !== 0) {
    throw new Error(`tar pack failed: ${String(packed.stderr).slice(0, 300)}`);
  }

  // 2. Upload the tar into the sandbox under a temp path.
  const remoteTar = `/tmp/agentbox-carry-${String(args.index)}.tar`;
  await args.backend.uploadFile(args.handle, localTar, remoteTar);

  // 3. mkdir + extract + optional chmod + optional chown + cleanup, in one
  //    bash command. Single-quoted args inside double-quoted command string —
  //    paths are safe because carry: dest values are user-provided absolute
  //    paths the resolver already vetted.
  const mode = entry.mode !== undefined ? entry.mode.toString(8).padStart(4, '0') : '';
  // Default: chown to the in-box vscode user (uid 1000). Explicit `user: 0`
  // (root) skips the chown so a root-owned extract stays root-owned.
  const uid = entry.user ?? 1000;
  // For files: tar's input contains a single entry at basename(absSrc), and
  // we extract at the dest's parent, then `mv` to the dest if the source
  // basename differs from the dest basename.
  const fileBase = !isDir ? basenameUnix(entry.absSrc) : '';
  const destBase = !isDir ? basenameUnix(boxDest) : '';
  const renameNeeded = !isDir && fileBase !== destBase;
  const parts: string[] = [
    `mkdir -p ${shellQuote(parentDir)}`,
    isDir
      ? `tar -xf ${remoteTar} -C ${shellQuote(boxDest)} --no-same-permissions --no-same-owner -m`
      : `tar -xf ${remoteTar} -C ${shellQuote(parentDir)} --no-same-permissions --no-same-owner -m`,
  ];
  if (renameNeeded) {
    parts.push(
      `mv ${shellQuote(`${parentDir}/${fileBase}`)} ${shellQuote(boxDest)}`,
    );
  }
  if (mode) parts.push(`chmod -R ${mode} ${shellQuote(boxDest)}`);
  parts.push(`chown -R ${String(uid)}:${String(uid)} ${shellQuote(boxDest)}`);
  parts.push(`rm -f ${remoteTar}`);
  const cmd = parts.join(' && ');

  const res = await args.backend.exec(args.handle, cmd);
  if (res.exitCode !== 0) {
    throw new Error(
      `in-box extract failed (exit ${String(res.exitCode)}): ${(res.stderr || res.stdout).slice(-300)}`,
    );
  }
}

function dirnameUnix(p: string): string {
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.slice(0, i);
}

function basenameUnix(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** Single-quote a shell argument; safe for any byte except NUL. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
