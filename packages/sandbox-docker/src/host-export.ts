import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
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

export const BOXES_ROOT = join(homedir(), '.agentbox', 'boxes');

export function boxRunDirFor(id: string): string {
  return join(BOXES_ROOT, id);
}

/**
 * Per-box durable status file. The host relay writes it (atomic tmp+rename)
 * when the in-box daemon pushes a `box-status` snapshot; it persists here on
 * the host fs even while the box is paused/stopped. Path must stay in sync
 * with `boxStatusPathFor` in @agentbox/relay's status-store.
 */
export function boxStatusPathFor(id: string): string {
  return join(boxRunDirFor(id), 'status.json');
}

/**
 * Read the persisted box status, or null when there is none (box predates the
 * feature, relay never received a push, corrupt JSON, or a future-incompatible
 * schema). Never throws — callers fall back to live/“unknown”.
 */
export async function readBoxStatus(id: string): Promise<BoxStatus | null> {
  try {
    const raw = await readFile(boxStatusPathFor(id), 'utf8');
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
  record: Pick<BoxRecord, 'id'>,
): Promise<HostPaths> {
  const boxDir = boxRunDirFor(record.id);
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
  record: Pick<BoxRecord, 'id' | 'container'>,
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
  record: Pick<BoxRecord, 'id' | 'container' | 'workspacePath'>,
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
  record: Pick<BoxRecord, 'id' | 'container'>,
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
    const opened = await execa('open', [hostPath], { reject: false });
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
