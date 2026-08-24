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
import { BOX_HOME, dirnameUnix, planCarryEntry } from '@agentbox/sandbox-core';

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
  // Shared, byte-for-byte carry decisions (~/ expansion, file-vs-dir, exclude,
  // owner/mode defaults, rename-needed, parent-chain-needed) — see
  // `@agentbox/sandbox-core`'s files concern. `~/` is expanded host-side, never
  // inside the box: the supervisor user's $HOME equals BOX_HOME, but the exec
  // shell's current user (the SDK's default) is not guaranteed to be vscode on
  // every backend, so an explicit destination path is required.
  const plan = planCarryEntry(entry);
  if (!plan) return; // missing (optional + absent on host)
  const { boxDest, isDir, parentDir, exclude, chownArgs, mode, fileBase, renameNeeded } = plan;
  // Pre-joined for the command string; holds no shell metacharacters by contract.
  const chownTarget = chownArgs.join(' ');

  // 1. Tar the host source on disk so backend.uploadFile (which takes a path,
  //    not a stream) has something to send.
  const localTar = join(args.stageDir, `carry-${String(args.index)}.tar`);
  const excludeArgs = isDir ? exclude.map((p) => `--exclude=${p}`) : [];
  const tarArgs = isDir
    ? ['-C', entry.absSrc, '-cf', localTar, ...excludeArgs, '.']
    : ['-C', dirnameUnix(entry.absSrc), '-cf', localTar, fileBase];
  // COPYFILE_DISABLE silences macOS BSD tar's `._*` resource-fork stubs, which
  // would otherwise land next to every carried file in the box (`._auth.json`
  // beside `auth.json`) and miss the entry's `mode`.
  const packed = await execa('tar', tarArgs, {
    reject: false,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
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
  //
  // For files: tar's input contains a single entry at basename(absSrc), and we
  // extract at the dest's parent, then `mv` to the dest when the source
  // basename differs from the dest basename.
  const parts: string[] = [
    `mkdir -p ${shellQuote(parentDir)}`,
    isDir
      ? `tar -xf ${remoteTar} -C ${shellQuote(boxDest)} --no-same-permissions --no-same-owner -m`
      : `tar -xf ${remoteTar} -C ${shellQuote(parentDir)} --no-same-permissions --no-same-owner -m`,
  ];
  if (renameNeeded) {
    parts.push(`mv ${shellQuote(`${parentDir}/${fileBase}`)} ${shellQuote(boxDest)}`);
  }
  if (mode) parts.push(`chmod -R ${mode} ${shellQuote(boxDest)}`);
  parts.push(`chown -R ${chownTarget} ${shellQuote(boxDest)}`);
  // Parent-chain chown: `mkdir -p` ran as root, so any new dirs between
  // $HOME and dirname(boxDest) are root-owned. Walk back up to $HOME
  // (exclusive) and chown each. Only when dest is under $HOME — system
  // paths like /etc/* keep their existing ownership.
  if (plan.parentChainNeeded) {
    parts.push(
      `parent=$(dirname ${shellQuote(boxDest)}); ` +
        `while [ "$parent" != "${BOX_HOME}" ] && [ "$parent" != "/" ]; do ` +
        `chown ${chownTarget} "$parent"; ` +
        `parent=$(dirname "$parent"); ` +
        `done`,
    );
  }
  parts.push(`rm -f ${remoteTar}`);
  const cmd = parts.join(' && ');

  // Vercel + E2B: force the whole chain to run as root.
  //
  // Vercel's reason is shell re-parsing: its exec wraps a non-root command in
  // `sudo -u vscode -H bash -lc '<cmd>'`, and that extra `bash -lc` nesting
  // mangles the `$(...)`/`$var`/`while` in the parent-chain walk (the parent var
  // expands empty → `dirname "."` loops forever → the exec hangs until timeout,
  // surfacing as "Stream ended before command finished"). Its single-`bash -lc`
  // root path doesn't re-parse, so the command runs cleanly.
  //
  // E2B's reason is permissions: tar extracts with `--no-same-owner`, so every
  // carried file is owned by whoever runs the extract. Only root can then hand
  // it to someone else, and E2B's default exec user is `vscode` — as vscode the
  // final `chown` fails with "Operation not permitted" and the parent-chain loop
  // never reaches its terminator.
  //
  // Running as root is safe for ownership because the chown resolves the box
  // user from `--reference=/home/vscode` (see CarryPlan.chownArgs) rather than a
  // hardcoded number, so the files land on the real vscode uid — 1000 on
  // docker/hetzner/digitalocean/daytona, whatever `useradd` picked on
  // vercel/e2b. Scoped to these two backends rather than made unconditional so
  // Hetzner/Daytona keep their existing (working, non-root) carry path.
  const wantsRoot = args.backend.name === 'vercel' || args.backend.name === 'e2b';
  const execOpts = wantsRoot ? { user: 'root' as const } : undefined;
  const res = await args.backend.exec(args.handle, cmd, execOpts);
  if (res.exitCode !== 0) {
    throw new Error(
      `in-box extract failed (exit ${String(res.exitCode)}): ${(res.stderr || res.stdout).slice(-300)}`,
    );
  }
}

/** Single-quote a shell argument; safe for any byte except NUL. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
