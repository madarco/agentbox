/**
 * Concern: workspace files — the provider-neutral half of moving a box's
 * `/workspace` back to the host (`agentbox download`, `agentbox clone`) and of
 * pushing the host's files into a live NON-GIT box (`agentbox sync`).
 *
 * Two things live here because they must not drift between providers:
 *
 *  - **The pull's second stage.** Docker materializes `/workspace` into a
 *    per-box host scratch dir over a bind mount; the clouds tar it out over the
 *    SDK. From that point on both are the same operation — a host-side `rsync -a
 *    --checksum` from the scratch dir into the user's working dir, driven by a
 *    NUL file list, reported as an itemized change list. That is
 *    {@link rsyncPullToHost}, and sharing it is what gives cloud `download` its
 *    `--dry-run` and its change list.
 *  - **The selection rules.** {@link buildWorkspaceListScript} is the one
 *    in-box enumerator: `git ls-files` when `/workspace` is a repo, else a
 *    `find` honouring {@link workspaceExcludes}. Exclude-list mode is not a
 *    fallback — for a service box whose workspace was never a git repo it is
 *    the ONLY mode, which is why its defaults have to be good enough to run
 *    unattended (no live databases, no media blobs, no agent state dir).
 *
 * The host→box direction for a non-git workspace is {@link overlayHostDirIntoBox}:
 * the same box-wins-content-hash policy the git resync uses
 * (`classifyUntrackedOverlay`), applied to a plain file list instead of git's
 * untracked set. Never deletes, never overwrites a box file that differs.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { LIVE_DATABASE_EXCLUDES } from '@agentbox/core';
import { classifyUntrackedOverlay } from './git.js';
import { AGENT_SYNC_SPECS } from '../registry.js';

/**
 * Directories excluded from an exclude-list-mode workspace pull, by basename,
 * at any depth. `.git` and `node_modules` are the historical pair; `media` is
 * new — a service agent (an AI gateway, a chat backend) accumulates uploaded
 * attachments under `media/` and they are not source.
 */
export const WORKSPACE_EXCLUDE_DIR_NAMES: readonly string[] = ['.git', 'node_modules', 'media'];

/**
 * Agent state directories, derived from every registered agent's declared
 * `staticPaths` rather than listed. These normally live under the box HOME, but
 * an agent pointed at `/workspace` as its working dir (openclaw's
 * `OPENCLAW_WORKSPACE_DIR`) drops the same tree inside the workspace — and a
 * gateway's state dir landing in the user's project folder is the failure this
 * guards. Home-relative paths are used verbatim as rsync/find patterns, so
 * `.config/opencode` excludes only that subtree, not all of `.config`.
 */
export function agentStateExcludePaths(): string[] {
  const out = new Set<string>();
  for (const spec of AGENT_SYNC_SPECS) {
    for (const p of spec.staticPaths) {
      if (p.hostHomeRel.length > 0) out.add(p.hostHomeRel.join('/'));
    }
  }
  return [...out].sort();
}

export interface WorkspaceExcludeOptions {
  /** Default false. When true, keep `node_modules` in the selection. */
  includeNodeModules?: boolean;
}

/**
 * Every exclude pattern an exclude-list-mode pull applies, as rsync/tar
 * patterns. Consumed both by {@link buildWorkspaceListScript} (which compiles
 * them into a `find` expression) and by {@link rsyncPullToHost} when there is
 * no file list at all.
 */
export function workspaceExcludes(opts: WorkspaceExcludeOptions = {}): string[] {
  const dirs = WORKSPACE_EXCLUDE_DIR_NAMES.filter(
    (d) => d !== 'node_modules' || !opts.includeNodeModules,
  );
  return [...dirs, ...agentStateExcludePaths(), ...LIVE_DATABASE_EXCLUDES];
}

/** Split an exclude pattern list into the three shapes `find` needs. */
function partitionExcludes(patterns: readonly string[]): {
  dirNames: string[];
  dirPaths: string[];
  fileGlobs: string[];
} {
  const dirNames: string[] = [];
  const dirPaths: string[] = [];
  const fileGlobs: string[] = [];
  for (const raw of patterns) {
    const p = raw.replace(/\/+$/, '');
    if (p.length === 0) continue;
    if (p.includes('*')) fileGlobs.push(p);
    else if (p.includes('/')) dirPaths.push(p);
    else dirNames.push(p);
  }
  return { dirNames, dirPaths, fileGlobs };
}

/** Single-quote a value for the POSIX shell. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Mode marker the list script prints on its first line. */
export type WorkspaceListMode = 'git' | 'exclude';

export interface WorkspaceListScriptOptions {
  /** In-box workspace dir (default `/workspace`). */
  workspaceDir?: string;
  /** Default true. When false, skip the git probe and always use the exclude list. */
  respectGitignore?: boolean;
  /** Exclude patterns for the non-git branch (see {@link workspaceExcludes}). */
  excludes: readonly string[];
}

/**
 * Build the in-box shell script that enumerates the workspace files a pull
 * should carry. Prints `MODE=git` or `MODE=exclude` followed by a newline, then
 * the NUL-delimited paths RELATIVE to the workspace dir — the exact shape rsync
 * `--files-from=- --from0` and `tar --null -T -` both consume.
 *
 * One script for both providers: docker runs it through `docker exec`, the
 * clouds through `backend.exec`. The mode marker is what lets the caller report
 * `(exclude-list mode)` truthfully instead of guessing from the workspace path.
 */
export function buildWorkspaceListScript(opts: WorkspaceListScriptOptions): string {
  const dir = opts.workspaceDir ?? '/workspace';
  const { dirNames, dirPaths, fileGlobs } = partitionExcludes(opts.excludes);
  const pruneTerms = [
    ...dirNames.map((n) => `-name ${sq(n)}`),
    ...dirPaths.map((p) => `-path ${sq(`./${p}`)}`),
  ];
  const prune =
    pruneTerms.length > 0 ? `\\( -type d \\( ${pruneTerms.join(' -o ')} \\) -prune \\) -o ` : '';
  // The excludes apply to FILES as well, not just to pruned directories: in a
  // linked git worktree `.git` is a regular file, and a `find` that only pruned
  // `-type d -name .git` let it through — rsync then failed outright trying to
  // replace the destination's `.git` DIRECTORY with it.
  const fileFilter = [
    ...dirNames.map((n) => `! -name ${sq(n)}`),
    ...dirPaths.flatMap((p) => [`! -path ${sq(`./${p}`)}`, `! -path ${sq(`./${p}/*`)}`]),
    ...fileGlobs.map((g) => `! -name ${sq(g)}`),
  ].join(' ');
  // `-print0` (not GNU's `-printf '%P\\0'`): this script also runs on the HOST,
  // where find may be BSD's. The leading `./` is stripped when parsing.
  // Symlinks ride along: rsync `-a` recreates them and a workspace that pins a
  // path with one would otherwise silently lose it in exclude-list mode.
  const findCmd = `find . ${prune}\\( \\( -type f -o -type l \\) ${fileFilter} -print0 \\)`;
  const gitProbe =
    opts.respectGitignore === false ? 'false' : 'git rev-parse --is-inside-work-tree';
  return [
    `set -u`,
    `cd ${sq(dir)} 2>/dev/null || exit 3`,
    `if ${gitProbe} >/dev/null 2>&1; then`,
    `  printf 'MODE=git\\n'`,
    `  git ls-files -z --cached --others --exclude-standard`,
    `else`,
    `  printf 'MODE=exclude\\n'`,
    `  ${findCmd}`,
    `fi`,
  ].join('\n');
}

export interface ParsedWorkspaceList {
  mode: WorkspaceListMode;
  /** NUL-joined relative paths; empty string when the workspace has no files. */
  fileList: string;
  /** The same paths, split. */
  paths: string[];
}

/** Parse {@link buildWorkspaceListScript}'s stdout. Throws on an unknown marker. */
export function parseWorkspaceList(stdout: string): ParsedWorkspaceList {
  const nl = stdout.indexOf('\n');
  const marker = nl >= 0 ? stdout.slice(0, nl) : stdout;
  const rest = nl >= 0 ? stdout.slice(nl + 1) : '';
  if (marker !== 'MODE=git' && marker !== 'MODE=exclude') {
    throw new Error(`workspace file list: unexpected mode marker ${JSON.stringify(marker)}`);
  }
  // `find -print0` emits `./a/b`; `git ls-files -z` emits `a/b`. Normalize so
  // both feed `rsync --files-from` / `tar -T` identically.
  const paths = rest
    .split('\0')
    .filter((p) => p.length > 0)
    .map((p) => (p.startsWith('./') ? p.slice(2) : p));
  return {
    mode: marker === 'MODE=git' ? 'git' : 'exclude',
    fileList: paths.join('\0'),
    paths,
  };
}

/**
 * Does `relPath` match one of the exclude patterns, using the same reading
 * `find`/rsync give them?
 *
 *  - a pattern with `/` matches that path prefix (`.config/opencode` hides that
 *    subtree, and nothing else under `.config`);
 *  - a pattern with `*` is a basename glob (`*.sqlite*`), matched at any depth;
 *  - a bare name matches any path SEGMENT (`node_modules`, `.git`).
 *
 * Used where the selection did not come from `find` — the git-mode list, which
 * `agentbox clone` still has to strip an agent state dir out of.
 */
export function isExcludedPath(relPath: string, patterns: readonly string[]): boolean {
  const segments = relPath.split('/');
  const base = segments[segments.length - 1] ?? '';
  for (const raw of patterns) {
    const p = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    if (p.length === 0) continue;
    if (p.includes('*')) {
      const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      if (re.test(base)) return true;
      continue;
    }
    if (p.includes('/')) {
      if (relPath === p || relPath.startsWith(`${p}/`)) return true;
      continue;
    }
    if (segments.includes(p)) return true;
  }
  return false;
}

/**
 * Keep only itemized lines that represent an actual file transfer or delete.
 * rsync `-i` emits a leading 11-char code: char 0 is the update type
 * (`>`/`<`/`c`/`*` = transfer/change/delete; `.` = attr-only, skipped) and char
 * 1 is the entry type (`f` file, `d` dir, ...). Directory lines (`d`) are
 * pruned: rsync creates parent dirs as a side effect of transferring files, so
 * counting them would overstate "files changed".
 */
export function parseItemizedChanges(stdout: string): string[] {
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

export interface RsyncPullArgs {
  /** Host dir holding the box's materialized `/workspace`. */
  scratchDir: string;
  /** The user's working dir the files land in (`box.workspacePath`). */
  destDir: string;
  /**
   * NUL-joined relative paths to copy, or null to fall back to an
   * `--exclude`-driven whole-tree copy.
   */
  fileList: string | null;
  /** `--exclude` patterns; only consulted when `fileList` is null. */
  excludes?: readonly string[];
  /** When true, run the dry-run pass only and return the change list. */
  dryRun?: boolean;
}

/**
 * Stage 2 of a workspace pull, shared by every provider: copy the staged
 * `/workspace` view into the user's working dir and report what changed.
 *
 * `--checksum`, not the default size+mtime quick-check: a box runs on a fresh
 * git worktree (or a fresh extract), so every file's mtime differs from the
 * user's working tree even when the content is byte-identical. Without `-c`
 * rsync would "update" the entire tree.
 *
 * Never passes `--delete`: files that exist on the host but not in the box are
 * preserved. Removals are the user's call.
 */
export async function rsyncPullToHost(
  args: RsyncPullArgs,
): Promise<{ changes: string[]; applied: boolean }> {
  const baseArgs = ['-a', '--checksum'];
  if (args.fileList === null) {
    for (const e of args.excludes ?? []) baseArgs.push(`--exclude=${e}`);
  } else {
    baseArgs.push('--files-from=-', '--from0');
  }
  const src = `${args.scratchDir}/`;
  const dst = `${args.destDir}/`;
  const input = args.fileList !== null ? args.fileList : undefined;

  const dry = await execa('rsync', [...baseArgs, '--dry-run', '-i', src, dst], {
    reject: false,
    input,
  });
  if (dry.exitCode !== 0) {
    throw new Error(`rsync dry-run failed: ${dry.stderr || dry.stdout}`);
  }
  const changes = parseItemizedChanges(dry.stdout);
  if (args.dryRun) return { changes, applied: false };

  const real = await execa('rsync', [...baseArgs, src, dst], { reject: false, input });
  if (real.exitCode !== 0) {
    throw new Error(`rsync into ${args.destDir} failed: ${real.stderr || real.stdout}`);
  }
  return { changes, applied: true };
}

// ── host → live box (the non-git leg of `agentbox sync`) ──────────────────────

/** What a non-git overlay needs from the box, whatever provider it is on. */
export interface WorkspaceOverlayPorts {
  /**
   * For each relative path, the box's token: absent when the path does not
   * exist, `NON_REGULAR_TOKEN` for a dir/symlink, else the sha256 of the file.
   * Mirrors `WorkspaceResyncPorts.probeUntrackedTokens`.
   */
  probeBoxTokens(relPaths: string[]): Promise<Map<string, string>>;
  /** Extract a tar (rooted at the workspace dir) into the box. */
  applyTarToBox(tar: Buffer): Promise<void>;
}

export interface WorkspaceOverlayResult {
  /** Paths copied into the box (absent there, or the box had no differing copy). */
  copied: string[];
  /** Paths the box already had with different content — the box's version kept. */
  skipped: string[];
  /** Paths that were byte-identical on both sides. */
  identical: number;
  /** True when the host dir had nothing to offer (empty or all excluded). */
  empty: boolean;
}

export interface OverlayHostDirArgs {
  /** Host dir to push (the user's workspace). */
  hostDir: string;
  /** Exclude patterns (see {@link workspaceExcludes}). */
  excludes: readonly string[];
  ports: WorkspaceOverlayPorts;
  onLog?: (line: string) => void;
}

/**
 * Push a host workspace into a live box that has no git repo to merge through.
 *
 * Same conflict policy as the git resync — **the box wins**. A host file is
 * copied only when the box does not have it; when the box has a different
 * version the host change is skipped (no marker, nothing clobbered) and
 * reported so the caller can tell the user. There is no base revision to
 * three-way against here, so "differs" is the whole conflict test.
 */
export async function overlayHostDirIntoBox(
  args: OverlayHostDirArgs,
): Promise<WorkspaceOverlayResult> {
  const log = args.onLog ?? ((): void => {});
  const rel = await listHostFiles(args.hostDir, args.excludes);
  if (rel.length === 0) {
    log('sync: nothing to push (host workspace is empty or fully excluded)');
    return { copied: [], skipped: [], identical: 0, empty: true };
  }

  const boxTokens = await args.ports.probeBoxTokens(rel);
  const copy: string[] = [];
  const skipped: string[] = [];
  let identical = 0;
  for (const p of rel) {
    let hostHash: string;
    try {
      hostHash = createHash('sha256')
        .update(await readFile(join(args.hostDir, p)))
        .digest('hex');
    } catch {
      // Raced away between the listing and the hash — nothing to push.
      continue;
    }
    const verdict = classifyUntrackedOverlay(boxTokens.get(p), hostHash);
    if (verdict === 'copy') copy.push(p);
    else if (verdict === 'conflict') skipped.push(p);
    else identical += 1;
  }

  if (copy.length > 0) {
    const tarOut = await execa('tar', ['-C', args.hostDir, '--null', '-T', '-', '-cf', '-'], {
      input: copy.join('\0'),
      encoding: 'buffer',
      reject: false,
    });
    if (tarOut.exitCode !== 0) {
      throw new Error(`tar of ${args.hostDir} failed`);
    }
    await args.ports.applyTarToBox(tarOut.stdout as Buffer);
  }
  log(
    `sync: ${String(copy.length)} copied, ${String(identical)} unchanged, ${String(skipped.length)} kept by the box`,
  );
  return { copied: copy, skipped, identical, empty: false };
}

/**
 * Enumerate a HOST dir with the same rules the in-box list script applies, so
 * the push and the pull select the same files. Runs the same `find` expression
 * through the local shell.
 */
export async function listHostFiles(
  hostDir: string,
  excludes: readonly string[],
): Promise<string[]> {
  const script = buildWorkspaceListScript({
    workspaceDir: hostDir,
    respectGitignore: false,
    excludes,
  });
  const r = await execa('bash', ['-c', script], { reject: false });
  if (r.exitCode !== 0) {
    throw new Error(`listing ${hostDir} failed: ${r.stderr || r.stdout}`);
  }
  return parseWorkspaceList(r.stdout).paths;
}
