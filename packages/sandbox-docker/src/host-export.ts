import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { sanitizeMnemonic } from '@agentbox/config';
import { hostOpenCommand } from '@agentbox/sandbox-core';
import type { ResolvedCarryEntry } from '@agentbox/core';
import type { BoxStatus } from '@agentbox/ctl';
import { execInBox } from './docker.js';
import type { BoxRecord } from './state.js';

export type DockerEngine = 'orbstack' | 'docker-desktop' | 'other';

/** In-container path bind-mounted to the per-box host export dir by createBox. */
export const CONTAINER_EXPORT_MERGED = '/host-export';

export interface HostPaths {
  /** Per-box runtime dir on host, e.g. ~/.agentbox/boxes/<id>. */
  boxDir: string;
  /** Snapshot target for the merged /workspace view (rsync'd in by `refreshExport`). */
  mergedExport: string;
}

let cachedEngine: DockerEngine | null = null;

/**
 * Inspect the docker daemon to decide which host-side conventions apply.
 * `docker info --format '{{.OperatingSystem}}'` returns strings like
 * "OrbStack" or "Docker Desktop" — we only care about those two on macOS.
 */
export async function detectEngine(): Promise<DockerEngine> {
  if (cachedEngine !== null) return cachedEngine;
  const result = await execa('docker', ['info', '--format', '{{.OperatingSystem}}'], {
    reject: false,
  });
  const os = (result.stdout ?? '').trim().toLowerCase();
  if (os.includes('orbstack')) cachedEngine = 'orbstack';
  else if (os.includes('docker desktop')) cachedEngine = 'docker-desktop';
  else cachedEngine = 'other';
  return cachedEngine;
}

/**
 * Pin the engine to a specific value, bypassing the `docker info` probe. Two
 * callers today:
 *  1. The CLI bootstrap (apps/cli) when the user has set `engine.kind` in
 *     ~/.agentbox/config.yaml — the override applies for the rest of the
 *     process so every `detectEngine()` returns the user's choice.
 *  2. Tests, via `__setEngineForTesting` (kept as an alias for back-compat).
 */
export function setEngineOverride(engine: DockerEngine | null): void {
  cachedEngine = engine;
}

/** @deprecated alias for `setEngineOverride`; kept so existing tests don't churn. */
export function __setEngineForTesting(engine: DockerEngine | null): void {
  cachedEngine = engine;
}

/**
 * The active Docker context name — `docker context show` (which honors the
 * `DOCKER_CONTEXT` / `DOCKER_HOST` overrides and `~/.docker/config.json`'s
 * `currentContext`). Embedded in the VS Code attached-container URI so the
 * Dev Containers extension talks to the same daemon agentbox used — without
 * it, switching engines (OrbStack ⇄ Docker Desktop) makes the extension probe
 * the wrong daemon. Best-effort: returns undefined if the probe fails.
 */
export async function getDockerContext(): Promise<string | undefined> {
  const result = await execa('docker', ['context', 'show'], { reject: false });
  if (result.exitCode !== 0) return undefined;
  const ctx = (result.stdout ?? '').trim();
  return ctx.length > 0 ? ctx : undefined;
}

export const BOXES_ROOT = join(homedir(), '.agentbox', 'boxes');

/** Box-identity subset every dir helper accepts. Structurally compatible with
 * `BoxRecord`, but only the fields the segment needs. `projectIndex` is the
 * 1-based per-project number (`agentbox list`'s `N` column); when present, it
 * appears between the id and the mnemonic so dir listings sort cleanly within
 * a project and the segment matches `agentbox <cmd> <n>` intuitively. Legacy
 * (pre-feature) boxes lack it and keep the original `<id>-<mnemonic>` shape.
 */
export interface BoxDirRef {
  id: string;
  name: string;
  projectIndex?: number;
}

/** On-disk dir segment for a box: `<id>-<n>-<mnemonic>` (or `<id>-<mnemonic>` legacy). */
export function boxDirSegment(box: BoxDirRef): string {
  const mnemonic = sanitizeMnemonic(box.name);
  const n = box.projectIndex;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
    return `${box.id}-${String(n)}-${mnemonic}`;
  }
  return `${box.id}-${mnemonic}`;
}

export function boxRunDirFor(box: BoxDirRef): string {
  return join(BOXES_ROOT, boxDirSegment(box));
}

/**
 * Per-box durable status file. The host relay writes it (atomic tmp+rename)
 * when the in-box daemon pushes a `box-status` snapshot; it persists here on
 * the host fs even while the box is paused/stopped. Path must stay in sync
 * with `boxStatusPathFor` in @agentbox/relay's status-store.
 */
export function boxStatusPathFor(box: BoxDirRef): string {
  return join(boxRunDirFor(box), 'status.json');
}

/**
 * Read the persisted box status, or null when there is none (box predates the
 * feature, relay never received a push, corrupt JSON, or a future-incompatible
 * schema). Never throws — callers fall back to live/“unknown”.
 */
export async function readBoxStatus(box: BoxDirRef): Promise<BoxStatus | null> {
  try {
    const raw = await readFile(boxStatusPathFor(box), 'utf8');
    const parsed = JSON.parse(raw) as BoxStatus;
    if (parsed.schema !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Host path to a subpath inside an OrbStack-managed named volume.
 *
 * OrbStack exposes named volumes at `~/OrbStack/docker/volumes/<name>/` —
 * NO `_data` wrapper. `docker volume inspect` reports the in-VM mountpoint
 * instead, which isn't reachable from macOS. Returns the path regardless of
 * whether it exists; callers stat it themselves. Used by claude's plugin-cache
 * pre-scan to find host-visible package.jsons on OrbStack.
 */
export function orbstackVolumePath(volume: string, ...sub: string[]): string {
  return join(homedir(), 'OrbStack', 'docker', 'volumes', volume, ...sub);
}

export async function getHostPaths(
  record: Pick<BoxRecord, 'id' | 'name' | 'projectIndex'>,
): Promise<HostPaths> {
  const boxDir = boxRunDirFor(record);
  return {
    boxDir,
    mergedExport: join(boxDir, 'workspace'),
  };
}

export interface RefreshOptions {
  /** When true, include /workspace/node_modules in the merged export. Off by default. */
  includeNodeModules?: boolean;
}

export interface RefreshResult {
  /** Host path that now reflects the box's current state. */
  hostPath: string;
  /** True when an rsync copy actually ran (always true today; kept for callers). */
  copied: boolean;
  /** True when the box predates the /host-export bind and we used the tar-pipe fallback. */
  usedFallback: boolean;
}

async function hasContainerPath(container: string, path: string): Promise<boolean> {
  const probe = await execInBox(container, ['test', '-d', path], { user: 'root' });
  return probe.exitCode === 0;
}

/**
 * Refresh the per-box merged host export (~/.agentbox/boxes/<id>/workspace) so
 * Finder sees the box's current `/workspace`. /workspace lives in the
 * container's writable layer and is invisible to macOS directly, so we always
 * have to copy it out. Prefers rsync via the /host-export bind-mount; falls
 * back to a `tar | tar` pipe through `docker exec` for boxes that predate the
 * bind.
 */
export async function refreshExport(
  record: Pick<BoxRecord, 'id' | 'name' | 'projectIndex' | 'container'>,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const paths = await getHostPaths(record);
  const excludeNodeModules = !opts.includeNodeModules;
  await mkdir(paths.mergedExport, { recursive: true });

  const bindAvailable = await hasContainerPath(record.container, CONTAINER_EXPORT_MERGED);
  if (bindAvailable) {
    const args = ['rsync', '-a', '--delete'];
    if (excludeNodeModules) args.push('--exclude=node_modules');
    args.push('/workspace/', `${CONTAINER_EXPORT_MERGED}/`);
    const r = await execInBox(record.container, args, { user: 'root' });
    if (r.exitCode !== 0) {
      throw new ExportError(`rsync into ${CONTAINER_EXPORT_MERGED} failed`, r.stdout, r.stderr);
    }
    return { hostPath: paths.mergedExport, copied: true, usedFallback: false };
  }

  // Fallback for pre-existing boxes: stream a tar through docker exec into the
  // host target. Slower and skips the in-place delete that rsync gives us, but
  // it works without recreating the container.
  const excludes = excludeNodeModules ? ['--exclude=node_modules'] : [];
  const result = await execa(
    'docker',
    ['exec', '--user', 'root', record.container, 'tar', '-cf', '-', ...excludes, '-C', '/workspace', '.'],
    { reject: false, encoding: 'buffer' },
  );
  if (result.exitCode !== 0) {
    throw new ExportError(
      `tar from /workspace failed`,
      '',
      typeof result.stderr === 'string' ? result.stderr : (result.stderr as Buffer).toString('utf8'),
    );
  }
  const extract = await execa('tar', ['-xf', '-', '-C', paths.mergedExport], {
    input: result.stdout as Buffer,
    reject: false,
  });
  if (extract.exitCode !== 0) {
    throw new ExportError('tar extract on host failed', extract.stdout, extract.stderr);
  }
  return { hostPath: paths.mergedExport, copied: true, usedFallback: true };
}

/**
 * Default env/config file basename globs for `pull env` / `pull --with-env`.
 * These are almost always gitignored, so a normal gitignore-aware `pull`
 * skips them; this list opts them back in explicitly. `agentbox.yaml` is
 * included so a file generated in-box by `/agentbox-setup` lands on the host
 * even before it's committed.
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
const ENV_PRUNE_DIRS = [
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  '.next',
  'build',
];

/**
 * Build the in-box `find` argv that enumerates env/config files by basename
 * glob, pruning `ENV_PRUNE_DIRS`. `-printf '%P\0'` emits NUL-delimited paths
 * already relative to /workspace (so they feed rsync --files-from --from0
 * directly, exactly like `git ls-files -z`).
 */
function buildEnvFindArgs(patterns: string[]): string[] {
  const nameGroup = (names: string[]): string[] => {
    const out: string[] = [];
    names.forEach((n, i) => {
      if (i > 0) out.push('-o');
      out.push('-name', n);
    });
    return out;
  };
  return [
    'find',
    '/workspace',
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
    '-printf',
    '%P\\0',
    ')',
  ];
}

/**
 * Host-side mirror of `buildEnvFindArgs` for the reverse direction (host →
 * box). Rooted at `.` (run with cwd = the host workspace) and uses `-print0`
 * instead of `-printf '%P\0'` because macOS's BSD `find` has no `-printf`;
 * `./relpath` entries feed `tar -C <workspace> --null -T -` directly, exactly
 * like the untracked-file pipe in git-worktree.ts.
 */
export function buildHostEnvFindArgs(patterns: string[]): string[] {
  const nameGroup = (names: string[]): string[] => {
    const out: string[] = [];
    names.forEach((n, i) => {
      if (i > 0) out.push('-o');
      out.push('-name', n);
    });
    return out;
  };
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

export interface CopyHostEnvOptions {
  /** Target container name (must be running with the overlay mounted). */
  container: string;
  /** Absolute host workspace dir — the same dir that maps to /workspace. */
  workspaceDir: string;
  /** Basename globs to copy (normally DEFAULT_ENV_PATTERNS). */
  patterns: string[];
  onLog?: (line: string) => void;
}

/**
 * Copy the host's env/config files (selected by `patterns`, gitignore ignored)
 * into the running box's `/workspace`. The reverse of `pullToHost`'s env
 * segment. Writes land in the overlay's writable upper layer (the container is
 * up + mounted at call time), so they survive pause/stop/start.
 *
 * Best-effort: a tar/exec failure or an empty match set logs and returns the
 * count rather than throwing — a missing secret shouldn't abort an otherwise
 * healthy box. Files extract as uid 1000 so they're owned by `vscode` like the
 * rest of /workspace.
 */
export async function copyHostEnvFilesToBox(
  opts: CopyHostEnvOptions,
): Promise<{ copied: number }> {
  const log = opts.onLog ?? (() => {});

  // Default (utf8) encoding: `find` output is NUL-delimited path text, and
  // `encoding:'buffer'` would hand back a Uint8Array whose .toString() is
  // comma-joined byte codes, not the paths.
  const found = await execa('find', buildHostEnvFindArgs(opts.patterns).slice(1), {
    cwd: opts.workspaceDir,
    reject: false,
  });
  if (found.exitCode !== 0) {
    log(`warning: env-file scan failed: ${String(found.stderr).slice(0, 300)}`);
    return { copied: 0 };
  }
  const list = String(found.stdout)
    .split('\0')
    .filter((p) => p.length > 0);
  if (list.length === 0) return { copied: 0 };

  // Same fork-and-stream as the untracked-file carry-over in git-worktree.ts.
  const packed = await execa('tar', ['-C', opts.workspaceDir, '--null', '-T', '-', '-cf', '-'], {
    input: list.join('\0'),
    encoding: 'buffer',
    reject: false,
  });
  if (packed.exitCode !== 0) {
    log(`warning: env-file tar pack failed: ${String(packed.stderr).slice(0, 300)}`);
    return { copied: 0 };
  }
  const extract = await execa(
    'docker',
    ['exec', '-i', '--user', '1000:1000', opts.container, 'tar', '-xf', '-', '-C', '/workspace'],
    { input: packed.stdout as Buffer, reject: false },
  );
  if (extract.exitCode !== 0) {
    log(`warning: env-file copy into box failed: ${String(extract.stderr).slice(0, 300)}`);
    return { copied: 0 };
  }
  return { copied: list.length };
}

/**
 * Run `buildHostEnvFindArgs` against `workspaceDir` and return the matched
 * paths as a relative-path string array. Pure host-side helper: no docker, no
 * mutation. Empty array on a scan failure (best-effort, matching
 * `copyHostEnvFilesToBox`). Used by the setup wizard to preview a multiselect
 * of importable env files.
 */
export async function scanHostEnvFiles(
  workspaceDir: string,
  patterns: string[],
): Promise<string[]> {
  if (patterns.length === 0) return [];
  const found = await execa('find', buildHostEnvFindArgs(patterns).slice(1), {
    cwd: workspaceDir,
    reject: false,
  });
  if (found.exitCode !== 0) return [];
  return String(found.stdout)
    .split('\0')
    .map((p) => p.replace(/^\.\//, ''))
    .filter((p) => p.length > 0);
}

export interface CopyHostFilesOptions {
  /** Target container name (must be running). */
  container: string;
  /** Absolute host workspace dir — the same dir that maps to /workspace. */
  workspaceDir: string;
  /** Relative paths (to workspaceDir) to copy. NUL-safe; no glob expansion. */
  files: string[];
  onLog?: (line: string) => void;
}

/**
 * Sibling to `copyHostEnvFilesToBox` that skips the `find` scan and trusts a
 * pre-vetted file list (e.g. the user's multiselect picks from the wizard).
 * Same tar-pipe body: tar reads the NUL-delimited list on stdin and pipes into
 * `docker exec tar -x`. Best-effort error handling — a tar/exec failure logs
 * and returns the count rather than throwing.
 */
export async function copyHostFilesToBox(
  opts: CopyHostFilesOptions,
): Promise<{ copied: number }> {
  const log = opts.onLog ?? (() => {});
  // Normalise — drop any leading "./" so the in-container extract lands at the
  // right path, and drop empties so a stray trailing NUL doesn't become `tar: ''`.
  const list = opts.files.map((p) => p.replace(/^\.\//, '')).filter((p) => p.length > 0);
  if (list.length === 0) return { copied: 0 };

  const packed = await execa('tar', ['-C', opts.workspaceDir, '--null', '-T', '-', '-cf', '-'], {
    input: list.join('\0'),
    encoding: 'buffer',
    reject: false,
  });
  if (packed.exitCode !== 0) {
    log(`warning: env-file tar pack failed: ${String(packed.stderr).slice(0, 300)}`);
    return { copied: 0 };
  }
  const extract = await execa(
    'docker',
    ['exec', '-i', '--user', '1000:1000', opts.container, 'tar', '-xf', '-', '-C', '/workspace'],
    { input: packed.stdout as Buffer, reject: false },
  );
  if (extract.exitCode !== 0) {
    log(`warning: env-file copy into box failed: ${String(extract.stderr).slice(0, 300)}`);
    return { copied: 0 };
  }
  return { copied: list.length };
}

export interface PullOptions {
  /** Default true. When false, skip git ls-files and use the static exclude-list. */
  respectGitignore?: boolean;
  /** Default false. When true, don't filter node_modules even in fallback mode. */
  includeNodeModules?: boolean;
  /** Default false. Skip the initial refreshExport — pull whatever's already in the scratch dir. */
  noRefresh?: boolean;
  /** Default false. Run rsync with --dry-run; return the change list without writing. */
  dryRun?: boolean;
  /**
   * Extra env/config files to pull, selected by these basename globs via an
   * in-box `find` (heavy dirs pruned). Composes WITH gitignore selection: the
   * rsync file list is the union of the git-tracked set (unless
   * respectGitignore is false) and these matches. Empty/undefined = no env
   * segment.
   */
  envPatterns?: string[];
}

export interface PullResult {
  /** Absolute host workspace path the pull targeted (record.workspacePath). */
  hostPath: string;
  /** Per-file rsync change list (itemized `-i` lines, transfers/deletes only). */
  changes: string[];
  /** True when an actual write happened. False on dry-run. */
  applied: boolean;
  /** True when gitignore-mode was used (vs. the fallback exclude-list). */
  usedGitignore: boolean;
}

/**
 * Keep only itemized lines that represent an actual file transfer or delete.
 * rsync `-i` emits a leading 11-char code: char 0 is the update type
 * (`>`/`<`/`c`/`*` = transfer/change/delete; `.` = attr-only, skipped) and
 * char 1 is the entry type (`f` file, `d` dir, ...). Directory lines (`d`)
 * are pruned: rsync creates parent dirs as a side effect of transferring
 * files, so counting them would overstate "files changed".
 */
function parseItemizedChanges(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .filter((l) => {
      const code = l[0];
      const kind = l[1];
      return (code === '>' || code === '<' || code === 'c' || code === '*') && kind !== 'd';
    });
}

/**
 * Reverse of `refreshExport`: bring the box's merged `/workspace` view back
 * into the user's actual host working directory (`record.workspacePath`).
 *
 * Two-stage: (1) `refreshExport` materializes `/workspace` in the per-box
 * scratch dir (`~/.agentbox/boxes/<id>/workspace`) — `/workspace` lives in
 * the container's writable layer, invisible to macOS directly; (2) a
 * host-side rsync copies scratch → `workspacePath`.
 *
 * Filtering: by default we ask git *inside the box* which files it would
 * track (`git ls-files --cached --others --exclude-standard`) so node_modules
 * / build dirs / gitignored secrets never leak back. Non-git workspaces (or
 * `respectGitignore: false`) fall back to a static `--exclude` list.
 *
 * Never passes `--delete`: files that exist on the host but not in the box
 * are preserved. Removals are the user's call.
 */
export async function pullToHost(
  record: Pick<BoxRecord, 'id' | 'name' | 'projectIndex' | 'container' | 'workspacePath'>,
  opts: PullOptions = {},
): Promise<PullResult> {
  const paths = await getHostPaths(record);

  let scratchDir: string;
  if (opts.noRefresh) {
    scratchDir = paths.mergedExport;
    await mkdir(scratchDir, { recursive: true });
  } else {
    const refreshed = await refreshExport(record, {
      includeNodeModules: opts.includeNodeModules,
    });
    scratchDir = refreshed.hostPath;
  }

  // The rsync file list is the union of up to two independent NUL-delimited
  // segments: git-tracked (gitignore-aware) and env-pattern (gitignore
  // bypassed). If neither is produced we fall through to the static
  // exclude-list (non-git workspace, no env patterns).
  const segments: string[] = [];
  let usedGitignore = false;
  if (opts.respectGitignore !== false) {
    const isGit = await execInBox(
      record.container,
      ['git', '-C', '/workspace', 'rev-parse', '--is-inside-work-tree'],
      { user: 'root' },
    );
    if (isGit.exitCode === 0 && isGit.stdout.trim() === 'true') {
      const ls = await execInBox(
        record.container,
        ['git', '-C', '/workspace', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { user: 'root' },
      );
      if (ls.exitCode !== 0) {
        throw new ExportError('git ls-files in box failed', ls.stdout, ls.stderr);
      }
      // git -z is NUL-delimited; rsync --from0 wants the same.
      const tracked = ls.stdout.replace(/\0$/, '');
      if (tracked.length > 0) segments.push(tracked);
      usedGitignore = true;
    }
  }
  if (opts.envPatterns && opts.envPatterns.length > 0) {
    const found = await execInBox(
      record.container,
      buildEnvFindArgs(opts.envPatterns),
      { user: 'root' },
    );
    if (found.exitCode !== 0) {
      throw new ExportError('find env files in box failed', found.stdout, found.stderr);
    }
    const envFiles = found.stdout.replace(/\0$/, '');
    if (envFiles.length > 0) segments.push(envFiles);
  }
  const fileList =
    segments.length > 0
      ? Array.from(new Set(segments.join('\0').split('\0'))).join('\0')
      : null;

  // --checksum, not the default size+mtime quick-check: the box runs on a
  // fresh git worktree so every file's mtime differs from the user's working
  // tree even when the content is byte-identical. Without -c, rsync would
  // "update" the entire tree. -c compares content hashes so only genuinely
  // changed files are written.
  const baseArgs = ['-a', '--checksum'];
  if (fileList === null) {
    baseArgs.push('--exclude=.git');
    if (!opts.includeNodeModules) baseArgs.push('--exclude=node_modules');
  } else {
    baseArgs.push('--files-from=-', '--from0');
  }
  const src = `${scratchDir}/`;
  const dst = `${record.workspacePath}/`;

  const dry = await execa('rsync', [...baseArgs, '--dry-run', '-i', src, dst], {
    reject: false,
    input: fileList !== null ? fileList : undefined,
  });
  if (dry.exitCode !== 0) {
    throw new ExportError('rsync dry-run failed', dry.stdout, dry.stderr);
  }
  const changes = parseItemizedChanges(dry.stdout);

  if (opts.dryRun) {
    return { hostPath: record.workspacePath, changes, applied: false, usedGitignore };
  }

  const real = await execa('rsync', [...baseArgs, src, dst], {
    reject: false,
    input: fileList !== null ? fileList : undefined,
  });
  if (real.exitCode !== 0) {
    throw new ExportError(`rsync into ${record.workspacePath} failed`, real.stdout, real.stderr);
  }
  return { hostPath: record.workspacePath, changes, applied: true, usedGitignore };
}

export interface OpenOptions extends RefreshOptions {
  /** When true, skip rsync and just open whatever's already on disk. */
  noRefresh?: boolean;
  /** When true, refresh as usual but don't launch macOS `open` on the resulting path. */
  noOpen?: boolean;
}

export interface OpenResult {
  hostPath: string;
  copied: boolean;
  usedFallback: boolean;
  engine: DockerEngine;
}

/**
 * Refresh the merged export (unless suppressed) and launch the macOS `open`
 * command on it. Returns the host path that was opened.
 *
 * Set `noOpen: true` to refresh and return the path without launching
 * Finder — used by `agentbox open --path` so scripted callers get a fresh
 * path in one call.
 */
export async function openInFinder(
  record: Pick<BoxRecord, 'id' | 'name' | 'projectIndex' | 'container'>,
  opts: OpenOptions,
): Promise<OpenResult> {
  const engine = await detectEngine();
  let hostPath: string;
  let copied = false;
  let usedFallback = false;

  if (opts.noRefresh) {
    const paths = await getHostPaths(record);
    hostPath = paths.mergedExport;
    await mkdir(hostPath, { recursive: true });
  } else {
    const refreshed = await refreshExport(record, opts);
    hostPath = refreshed.hostPath;
    copied = refreshed.copied;
    usedFallback = refreshed.usedFallback;
  }

  if (!opts.noOpen) {
    const opened = await execa(hostOpenCommand(), [hostPath], { reject: false });
    if (opened.exitCode !== 0) {
      throw new ExportError(`open ${hostPath} failed`, opened.stdout, opened.stderr);
    }
  }

  return { hostPath, copied, usedFallback, engine };
}

export class ExportError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`${message}${stderr ? `: ${stderr.trim()}` : ''}`);
    this.name = 'ExportError';
  }
}

export interface CopyCarryOptions {
  /** Running container name. */
  container: string;
  /** Resolved + approved carry entries. */
  entries: ResolvedCarryEntry[];
  onLog?: (line: string) => void;
}

export interface CopyCarryResult {
  copied: number;
  errors: string[];
  /** Audit summary for BoxRecord.carry. `hash` is the host source content hash at copy time. */
  applied: Array<{ src: string; dest: string; bytes: number; hash?: string }>;
}

/**
 * Content hash of a carry source, used by the on-start resync to re-copy only
 * entries whose host source changed. Files hash their bytes; dirs hash a
 * deterministic manifest of (relpath, size, mtime). Returns undefined on a read
 * error (treated as "changed" so a re-copy is attempted). `missing` → undefined.
 */
export async function carrySourceHash(entry: ResolvedCarryEntry): Promise<string | undefined> {
  if (entry.kind === 'missing') return undefined;
  try {
    if (entry.kind === 'file') {
      return createHash('sha256').update(await readFile(entry.absSrc)).digest('hex');
    }
    // Hash file *content* (not mtime) so a touch with identical content doesn't
    // trigger a spurious re-copy. Carry sources are size-capped, so reading them
    // is cheap.
    const h = createHash('sha256');
    const walk = async (dir: string, rel: string): Promise<void> => {
      const names = (await readdir(dir)).sort();
      for (const name of names) {
        const abs = join(dir, name);
        const relPath = rel ? `${rel}/${name}` : name;
        const st = await stat(abs);
        if (st.isDirectory()) {
          h.update(`d\0${relPath}\n`);
          await walk(abs, relPath);
        } else {
          h.update(`f\0${relPath}\0`);
          h.update(await readFile(abs));
          h.update('\n');
        }
      }
    };
    await walk(entry.absSrc, '');
    return h.digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Apply the `carry:` block: copy each host path to its declared in-box dest.
 * Per-entry tar pipe (not muxed onto one stream) because each entry has its
 * own dest. `~/` in `absDest` is expanded inside the container via `$HOME` —
 * never on the host — so the box's vscode home (`/home/vscode`) is the
 * reference, not the user's macOS home.
 *
 * Files: tar a single regular file (preserves mode) and extract at the parent
 * of dest, renamed to the basename of dest. Dirs: tar the directory contents
 * (after `cd src`) and extract into the dest path (which is created with
 * `mkdir -p`). Both extracts pass `--no-same-permissions --no-same-owner` so
 * macOS attrs don't leak in; a recursive `chmod` runs when `mode` is set.
 *
 * `missing` entries (optional + absent on host) are silently skipped.
 * Per-entry failures are recorded in `errors` and the function returns rather
 * than throwing — the box stays usable; the caller logs the misses.
 */
export async function copyCarryPathsToBox(opts: CopyCarryOptions): Promise<CopyCarryResult> {
  const log = opts.onLog ?? (() => {});
  let copied = 0;
  const errors: string[] = [];
  const applied: CopyCarryResult['applied'] = [];

  for (const [i, entry] of opts.entries.entries()) {
    const where = `carry[${String(i)}] "${entry.rawSrc}"`;
    if (entry.kind === 'missing') {
      log(`${where}: skipped (missing on host, optional)`);
      continue;
    }
    try {
      await copyOneEntry(opts.container, entry);
      copied += 1;
      applied.push({
        src: entry.absSrc,
        dest: entry.absDest,
        bytes: entry.bytes ?? 0,
        hash: await carrySourceHash(entry),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${where}: ${msg}`);
      log(`${where}: failed: ${msg}`);
    }
  }

  return { copied, errors, applied };
}

/** Hardcoded box home — boxes always run as the `vscode` user (uid 1000). */
const BOX_HOME = '/home/vscode';

async function copyOneEntry(container: string, entry: ResolvedCarryEntry): Promise<void> {
  if (entry.kind === 'missing') return;

  // ~/ in the dest expands to /home/vscode at this layer (host-side), NOT
  // inside the box's shell — so we never depend on the executing user's
  // $HOME (which is /root when we --user 0:0 below).
  const boxDest = entry.absDest.startsWith('~/')
    ? `${BOX_HOME}/${entry.absDest.slice(2)}`
    : entry.absDest;

  const boxDestParent = boxDest.endsWith('/') ? boxDest.slice(0, -1) : boxDest;
  const parentDir = entry.kind === 'dir' ? boxDestParent : dirnameUnix(boxDestParent);

  // Pre-create the dest's parent dir. Run as root so destinations outside
  // /home/vscode work; we re-chown to vscode if the dest is in $HOME.
  const mkdir = await execa(
    'docker',
    ['exec', '--user', '0:0', container, 'mkdir', '-p', parentDir],
    { reject: false },
  );
  if (mkdir.exitCode !== 0) {
    throw new Error(`mkdir -p ${parentDir} failed: ${String(mkdir.stderr).slice(0, 300)}`);
  }

  if (entry.kind === 'file') {
    // docker cp preserves file mode and writes to the exact destination path
    // (no shell, no transform expression — sidesteps all the quoting traps).
    const cp = await execa(
      'docker',
      ['cp', entry.absSrc, `${container}:${boxDest}`],
      { reject: false },
    );
    if (cp.exitCode !== 0) {
      throw new Error(`docker cp failed: ${String(cp.stderr).slice(0, 300)}`);
    }
  } else {
    // Tar the directory contents (cd in + tar .) so they extract at the
    // dest without a duplicated basename layer. --no-same-permissions /
    // --no-same-owner so macOS attrs don't leak into the linux box.
    const packed = await execa(
      'tar',
      ['-C', entry.absSrc, '-cf', '-', '.'],
      { encoding: 'buffer', reject: false },
    );
    if (packed.exitCode !== 0) {
      throw new Error(`tar pack failed: ${String(packed.stderr).slice(0, 300)}`);
    }
    const extract = await execa(
      'docker',
      [
        'exec',
        '-i',
        '--user',
        '0:0',
        container,
        'tar',
        '-xf',
        '-',
        '-C',
        boxDest,
        '--no-same-permissions',
        '--no-same-owner',
        '-m',
      ],
      { input: packed.stdout as Buffer, reject: false },
    );
    if (extract.exitCode !== 0) {
      throw new Error(`tar extract failed: ${String(extract.stderr).slice(0, 300)}`);
    }
  }

  if (entry.mode !== undefined) {
    const modeStr = entry.mode.toString(8).padStart(4, '0');
    const chmod = await execa(
      'docker',
      ['exec', '--user', '0:0', container, 'chmod', '-R', modeStr, boxDest],
      { reject: false },
    );
    if (chmod.exitCode !== 0) {
      throw new Error(`chmod failed: ${String(chmod.stderr).slice(0, 300)}`);
    }
  }

  // Always chown explicitly so the result is predictable across providers.
  // Default uid 1000 (in-box vscode); `user: 0` lands explicit root:root.
  // (For docker cp this matters — without an explicit chown the host's
  // macOS uid/gid leaks through into the container.)
  const uid = entry.user ?? 1000;
  const chown = await execa(
    'docker',
    ['exec', '--user', '0:0', container, 'chown', '-R', `${String(uid)}:${String(uid)}`, boxDest],
    { reject: false },
  );
  if (chown.exitCode !== 0) {
    throw new Error(`chown failed: ${String(chown.stderr).slice(0, 300)}`);
  }

  // Parent-chain chown: `mkdir -p` above ran as root, so any new dirs
  // between $HOME and dirname(boxDest) are root-owned even though the
  // leaf is now uid-owned. Walk back up to $HOME (exclusive) and chown
  // each. Only walk when dest is under $HOME — for destinations like
  // /etc/* or /opt/*, leave system parents alone.
  if (boxDest.startsWith(BOX_HOME + '/') && dirnameUnix(boxDest) !== BOX_HOME) {
    const safeDest = boxDest.replace(/'/g, `'\\''`);
    const script =
      `set -e; parent="$(dirname '${safeDest}')"; ` +
      `while [ "$parent" != "${BOX_HOME}" ] && [ "$parent" != "/" ]; do ` +
      `chown ${String(uid)}:${String(uid)} "$parent"; ` +
      `parent="$(dirname "$parent")"; ` +
      `done`;
    const chownParents = await execa(
      'docker',
      ['exec', '--user', '0:0', container, 'bash', '-c', script],
      { reject: false },
    );
    if (chownParents.exitCode !== 0) {
      throw new Error(`chown parents failed: ${String(chownParents.stderr).slice(0, 300)}`);
    }
  }
}

/** dirname() that always uses '/' regardless of host OS (box is linux). */
function dirnameUnix(p: string): string {
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.slice(0, i);
}
