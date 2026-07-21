/**
 * Concern: env/config files (`.env`, `secrets.toml`, `agentbox.yaml`, …) copied
 * host→box into `/workspace` at create, gitignore-bypassing.
 *
 * Unifies docker `copyHostEnvFilesToBox` (`sandbox-docker/host-export.ts`) and
 * cloud `uploadEnvFiles` (`sandbox-cloud/env-files.ts`): the host-side `find` +
 * `tar --null -T -` pack is identical across providers and lives here; the only
 * difference — how the tarball is extracted into the box — is the transport's
 * `applyTarball`. Both providers now delegate here, injecting their transport.
 *
 * Best-effort: a scan/pack failure or empty match set logs and returns the count
 * rather than throwing — a missing optional secret must not abort a healthy box.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { SyncTransport } from '@agentbox/core';
import type { SyncContext } from '../context.js';

/**
 * Default env/config file basename globs. These are almost always gitignored,
 * so a normal gitignore-aware pull skips them; this list opts them back in.
 * `agentbox.yaml` is included so an in-box `/agentbox-setup`-generated file
 * lands on the host even before it's committed.
 */
export const DEFAULT_ENV_PATTERNS = [
  '.env',
  '.env.*',
  '.envrc',
  '.dev.vars',
  'secrets.toml',
  'local.settings.json',
  'appsettings.*.json',
  'agentbox.yaml',
];

/** Directories the env-file `find` prunes — heavy or never-relevant. */
export const ENV_PRUNE_DIRS = [
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  '.next',
  'build',
];

function nameGroup(names: string[]): string[] {
  const out: string[] = [];
  names.forEach((n, i) => {
    if (i > 0) out.push('-o');
    out.push('-name', n);
  });
  return out;
}

/**
 * Host-side `find` argv enumerating env/config files by basename glob, pruning
 * `ENV_PRUNE_DIRS`. Rooted at `.` (run with cwd = the host workspace) with
 * `-print0` (BSD `find` on macOS has no `-printf`); `./relpath` entries feed
 * `tar -C <workspace> --null -T -` directly.
 */
export function buildHostEnvFindArgs(patterns: string[]): string[] {
  return [
    'find',
    '.',
    '(',
    '-type',
    'd',
    '(',
    ...nameGroup(ENV_PRUNE_DIRS),
    ')',
    '-prune',
    ')',
    '-o',
    '(',
    '-type',
    'f',
    '(',
    ...nameGroup(patterns),
    ')',
    '-print0',
    ')',
  ];
}

/**
 * Raw `find` output relative to `workspaceDir` — `./relpath` entries, NUL-split,
 * NO `./` stripping. This is what feeds `tar -C <workspaceDir> --null -T -`
 * (which handles `./relpath` directly), so `pushEnvFiles` uses it verbatim to
 * stay byte-identical to the pre-refactor copy. Empty on a scan failure or empty
 * pattern set (best-effort).
 */
async function findEnvFilesForTar(workspaceDir: string, patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const found = await execa('find', buildHostEnvFindArgs(patterns).slice(1), {
    cwd: workspaceDir,
    reject: false,
  });
  if (found.exitCode !== 0) return [];
  return String(found.stdout)
    .split('\0')
    .filter((p) => p.length > 0);
}

/**
 * Run `buildHostEnvFindArgs` against `workspaceDir` and return the matched
 * relative paths with the leading `./` stripped — the display/preview form used
 * by the setup wizard's multiselect. Pure host-side helper (no box mutation).
 * Empty on a scan failure or empty pattern set (best-effort).
 */
export async function scanHostEnvFiles(workspaceDir: string, patterns: string[]): Promise<string[]> {
  const raw = await findEnvFilesForTar(workspaceDir, patterns);
  return raw.map((p) => p.replace(/^\.\//, '')).filter((p) => p.length > 0);
}

export interface PushEnvFilesResult {
  /** Number of files written into the box. 0 when nothing matched. */
  copied: number;
}

/**
 * Copy the host's env/config files (selected by `patterns`) into the box's
 * `/workspace`, gitignore-bypassing. Files land owned by uid 1000 (`vscode`).
 */
export async function pushEnvFiles(
  ctx: SyncContext,
  transport: SyncTransport,
  patterns: string[],
): Promise<PushEnvFilesResult> {
  const list = await findEnvFilesForTar(ctx.hostWorkspace, patterns);
  if (list.length === 0) return { copied: 0 };

  const stage = await mkdtemp(join(tmpdir(), 'agentbox-envfiles-'));
  const localTar = join(stage, 'envfiles.tar');
  try {
    const packed = await execa(
      'tar',
      ['-C', ctx.hostWorkspace, '--null', '-T', '-', '-cf', localTar],
      { input: list.join('\0'), reject: false },
    );
    if (packed.exitCode !== 0) {
      ctx.onLog(`warning: env-file tar pack failed: ${String(packed.stderr).slice(0, 300)}`);
      return { copied: 0 };
    }
    try {
      await transport.applyTarball(localTar, ctx.boxWorkspace, { uid: 1000 });
    } catch (err) {
      ctx.onLog(
        `warning: env-file copy into box failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { copied: 0 };
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { copied: list.length };
}
