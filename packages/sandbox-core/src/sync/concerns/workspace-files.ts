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
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { LIVE_DATABASE_EXCLUDES } from '@agentbox/core';
import { classifyUntrackedOverlay } from './git.js';
import { AGENT_SYNC_SPECS } from '../registry.js';

/**
 * Generated directories, by basename at ANY depth: dependencies, build output,
 * caches and Python envs. A workspace move between host and box skips them by
 * default, in BOTH directions, on top of whatever gitignore already skips.
 *
 * They are rebuilt on the side that uses them, and most are built for one
 * platform: a box's `uv sync` writes a Linux `.venv`, its `pnpm install` a Linux
 * `node_modules`, and neither works on a Mac (nor a Mac one in the box).
 * Gitignore alone is not enough, because git inside the box never sees the
 * host's GLOBAL gitignore -- a project that relied on one had the box's `.venv`
 * pulled over the Mac's.
 *
 * Applied to UNTRACKED files only. A tracked file under a committed `dist/` is
 * the user's own content and moves like any other tracked file. Where there is
 * no git (exclude-list mode, the non-git seed) every file is untracked, so the
 * list applies to all of them.
 *
 * One switch turns the whole list off: `download --all` / `clone --all` on the
 * way out, `box.carryAll` (or `upload --all`) on the way in. The docker host
 * snapshot prunes the same list (`EXCLUDE_DIRS` in sandbox-docker).
 */
export const GENERATED_DIR_NAMES: readonly string[] = [
  'node_modules',
  '.next',
  '.nuxt',
  '.turbo',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.parcel-cache',
];

/**
 * Directories excluded from an exclude-list-mode workspace pull, by basename,
 * at any depth, whatever `--all` says.
 *
 * `.agentbox` is ours, not the user's: a box-local dir AgentBox regenerates
 * every boot (openclaw's derived box facts live there, because openclaw will
 * only read a system prompt from inside its own workspace). Pulling it back
 * would put a generated file describing THIS box into the user's project.
 *
 * `media` is a default only (see {@link workspaceExcludes}): a service agent
 * accumulates uploaded attachments under `media/` and they are not source.
 */
export const WORKSPACE_EXCLUDE_DIR_NAMES: readonly string[] = ['.git', '.agentbox'];

/**
 * Directories dropped from the GIT-mode selection as well, tracked or not, by
 * pathspec.
 *
 * Git mode otherwise carries every tracked file, on purpose: a tracked `.claude/`
 * there is the user's own content and dropping it would be a regression.
 * `.agentbox` is the one thing that is never the user's content — AgentBox
 * generates it in the box every boot (openclaw's derived box facts, which have to
 * live inside the workspace because openclaw will not read a system prompt from
 * outside it), so pulling it back would write a file describing THIS box into the
 * project.
 *
 * A pathspec rather than the box's `.git/info/exclude`, which cannot do the job:
 * in a docker box `/workspace/.git` is a linked-worktree FILE whose per-worktree
 * `info/exclude` git does not read, and the common dir it does read is the
 * user's bind-mounted host repo.
 */
export const GIT_MODE_EXCLUDE_DIRS: readonly string[] = ['.agentbox'];

export interface WorkspaceExcludeOptions {
  /**
   * Default false. When true, keep the {@link GENERATED_DIR_NAMES} dirs (and
   * `media/` in exclude-list mode): `download --all`, `clone --all`,
   * `box.carryAll`. `.git` and `.agentbox` are dropped regardless.
   */
  all?: boolean;
}

/** The basenames a host -> box seed drops: ours, plus the generated dirs unless kept. */
function seedDropNames(opts: WorkspaceExcludeOptions): string[] {
  return [...GIT_MODE_EXCLUDE_DIRS, ...(opts.all ? [] : GENERATED_DIR_NAMES)];
}

/**
 * The same dirs, as `tar --exclude` arguments for a host -> box NON-GIT seed
 * (the docker and cloud no-git tarballs). With no git, every file is untracked,
 * so the generated dirs go too unless `box.carryAll` keeps them.
 *
 * The invariant this closes: **`.agentbox/` never crosses the box boundary, in
 * either direction.** `<project>/.agentbox/bots/` — where `download --backup`
 * writes a bot's workspace AND its gateway identity — would otherwise be copied
 * into every new box created from that project, growing with each backup.
 *
 * ANY-DEPTH, not root-anchored, and that is forced as well as wanted. Forced:
 * neither tar anchors an exclude — MEASURED on bsdtar 3.5.3 (macOS) and true of
 * GNU tar, which defaults to `--no-anchored`. Wanted: a nested one is ours too —
 * `download --backup` run from a monorepo sub-project writes
 * `packages/foo/.agentbox/`.
 *
 * A bare name also matches a FILE of that name (a file called `build`), and
 * nothing portable fixes that: bsdtar reads `--exclude=build/` as "file or dir"
 * as well, and GNU tar never matches the trailing-slash form at all (both
 * MEASURED). The git carry-over ({@link dropHostOnlyPaths}) is dir-only.
 */
export function seedExcludeTarArgs(opts: WorkspaceExcludeOptions = {}): string[] {
  return seedDropNames(opts).map((d) => `--exclude=${d}`);
}

/**
 * Drop the same dirs from a NUL-joined `git ls-files --others` list — the
 * untracked carry-over leg of a git-backed seed and of the resync, which tar a
 * vetted file list rather than a whole directory. Tracked files reach the box
 * through git, so they never pass through here.
 *
 * Belt-and-braces for `.agentbox/`: `--exclude-standard` already skips a
 * gitignored one, and `download --backup` writes that gitignore entry. The
 * invariant must not depend on that write having succeeded.
 *
 * The generated dirs are matched as DIRECTORIES at any depth (`isExcludedPath`'s
 * `name/` rule), so an untracked file merely named `build` still goes.
 *
 * Tolerates an unterminated tail: `git ls-files -z` NUL-TERMINATES rather than
 * NUL-separates, and treating the two the same is how the last path in a list
 * has been dropped here before.
 */
export function dropHostOnlyPaths(nulList: string, opts: WorkspaceExcludeOptions = {}): string {
  const drop = [
    ...GIT_MODE_EXCLUDE_DIRS,
    ...(opts.all ? [] : GENERATED_DIR_NAMES.map((d) => `${d}/`)),
  ];
  const kept = nulList.split('\0').filter((p) => p.length > 0 && !isExcludedPath(p, drop));
  return kept.length > 0 ? `${kept.join('\0')}\0` : '';
}

/**
 * The pathspecs for the UNTRACKED leg of the git-mode selection (`git ls-files
 * --others --exclude-standard -- . <these>`). The tracked leg only drops
 * {@link GIT_MODE_EXCLUDE_DIRS}.
 *
 * `.agentbox` is one dir at the workspace root, so one root-anchored pathspec
 * says exactly what is meant. Each generated dir is matched at ANY depth, as a
 * directory: `d/*` and `*` + `/d/*` (a pathspec `*` crosses `/`). Neither form
 * matches a file merely named `d`, nor `distribution/` or `my_build.py` —
 * MEASURED against git 2.39.
 */
export function untrackedExcludePathspecs(opts: WorkspaceExcludeOptions = {}): string[] {
  const specs = GIT_MODE_EXCLUDE_DIRS.map((d) => `:(exclude)${d}`);
  if (!opts.all) {
    for (const d of GENERATED_DIR_NAMES) specs.push(`:(exclude)${d}/*`, `:(exclude)*/${d}/*`);
  }
  return specs;
}

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

/**
 * Every exclude pattern an exclude-list-mode move applies, as rsync/find
 * patterns. Consumed by {@link buildWorkspaceListScript} (which compiles them
 * into a `find` expression), by {@link rsyncPullToHost} when there is no file
 * list at all, and by the non-git `upload`.
 *
 * The generated dirs are written `name/`: rsync's directory-only form, which
 * `find` and {@link isExcludedPath} read the same way.
 *
 * `all` keeps the generated dirs and `media/`. It does NOT keep the agent state
 * dirs or live databases: those are not junk but identity (a gateway token) and
 * a half-written sqlite file, and no "give me everything" should copy either.
 */
export function workspaceExcludes(opts: WorkspaceExcludeOptions = {}): string[] {
  const defaults = opts.all ? [] : ['media', ...GENERATED_DIR_NAMES.map((d) => `${d}/`)];
  return [
    ...WORKSPACE_EXCLUDE_DIR_NAMES,
    ...defaults,
    ...agentStateExcludePaths(),
    ...LIVE_DATABASE_EXCLUDES,
  ];
}

/** Split an exclude pattern list into the shapes `find` needs. */
function partitionExcludes(patterns: readonly string[]): {
  dirNames: string[];
  dirOnlyNames: string[];
  dirPaths: string[];
  fileGlobs: string[];
} {
  const dirNames: string[] = [];
  const dirOnlyNames: string[] = [];
  const dirPaths: string[] = [];
  const fileGlobs: string[] = [];
  for (const raw of patterns) {
    const p = raw.replace(/\/+$/, '');
    if (p.length === 0) continue;
    if (p.includes('*')) fileGlobs.push(p);
    else if (p.includes('/')) dirPaths.push(p);
    else if (raw.endsWith('/')) dirOnlyNames.push(p);
    else dirNames.push(p);
  }
  return { dirNames, dirOnlyNames, dirPaths, fileGlobs };
}

/** Single-quote a value for the POSIX shell. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Mode marker the list script prints on its first line. */
export type WorkspaceListMode = 'git' | 'exclude';

export interface WorkspaceListScriptOptions extends WorkspaceExcludeOptions {
  /** In-box workspace dir (default `/workspace`). */
  workspaceDir?: string;
  /** Default true. When false, skip the git probe and always use the exclude list. */
  respectGitignore?: boolean;
  /**
   * Exclude patterns for the non-git branch (see {@link workspaceExcludes}).
   * The git branch reads `all` instead: both must be told, or the two modes
   * disagree about the one flag the user set.
   */
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
  const { dirNames, dirOnlyNames, dirPaths, fileGlobs } = partitionExcludes(opts.excludes);
  const pruneTerms = [
    ...[...dirNames, ...dirOnlyNames].map((n) => `-name ${sq(n)}`),
    ...dirPaths.map((p) => `-path ${sq(`./${p}`)}`),
  ];
  const prune =
    pruneTerms.length > 0 ? `\\( -type d \\( ${pruneTerms.join(' -o ')} \\) -prune \\) -o ` : '';
  // The excludes apply to FILES as well, not just to pruned directories: in a
  // linked git worktree `.git` is a regular file, and a `find` that only pruned
  // `-type d -name .git` let it through — rsync then failed outright trying to
  // replace the destination's `.git` DIRECTORY with it. A `name/` pattern is
  // the exception: directory-only, so a file merely called `build` survives.
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
  const trackedPathspecs = GIT_MODE_EXCLUDE_DIRS.map((d) => sq(`:(exclude)${d}`)).join(' ');
  const untrackedPathspecs = untrackedExcludePathspecs(opts).map(sq).join(' ');
  // Everything the git branch prints is passed through an existence test, so the
  // list can only ever name a path that is really there.
  //
  // That invariant is the whole point. `git ls-files --cached` happily prints an
  // index entry whose worktree file was DELETED, and a listed-but-absent path is
  // fatal on both transports: rsync exits 23 (`link_stat ... No such file`) and
  // the shared `rsyncPullToHost` throws on its dry run, while the cloud tar dies
  // with `Cannot stat` under `set -e`. Same bug, two transports.
  //
  // `-f`/`-L` mirrors the find branch's `-type f -o -type l`, which also drops a
  // gitlink (a submodule, which `--cached` prints as a DIRECTORY): tar would
  // recurse into it and pull its `.git`, while `rsync --files-from` would not
  // recurse at all, so the two staging paths disagreed in both directions.
  //
  // `xargs -0` rather than a `while read -d ''` loop: bash reads a pipe a byte at
  // a time, measured at 8.6s vs 2.65s over 138k paths. No `-r` (BSD xargs has
  // none) — with empty input `sh` runs once with no positional args and the loop
  // prints nothing. No temp file and no process substitution, because a Vercel
  // box has no `/dev/fd`.
  const existingOnly = `xargs -0 sh -c 'for f do if [ -f "$f" ] || [ -L "$f" ]; then printf "%s\\0" "$f"; fi; done' _`;
  return [
    `set -u`,
    // Without pipefail a failing `git ls-files` is invisible: the pipeline exits
    // 0 and the short list reads as "this workspace has fewer files".
    `set -o pipefail`,
    `cd ${sq(dir)} 2>/dev/null || exit 3`,
    `if ${gitProbe} >/dev/null 2>&1; then`,
    `  printf 'MODE=git\\n'`,
    // Two legs, so the generated-dir list only ever touches UNTRACKED files: a
    // tracked file under a committed `dist/` is the user's and comes back. `&&`
    // so a failing first leg fails the group, and pipefail reports it.
    `  { git ls-files -z --cached -- . ${trackedPathspecs} &&`,
    `    git ls-files -z --others --exclude-standard -- . ${untrackedPathspecs}; } |`,
    `    ${existingOnly}`,
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
 *  - a bare name matches any path SEGMENT (`media`, `.git`);
 *  - a bare name with a trailing `/` (`dist/`) matches a DIRECTORY segment only,
 *    as rsync reads it: `dist/a` yes, a file called `scripts/dist` no.
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
    const dirSegments = raw.endsWith('/') ? segments.slice(0, -1) : segments;
    if (dirSegments.includes(p)) return true;
  }
  return false;
}

/** One itemized rsync line, split into the parts a caller can act on. */
export interface ItemizedChange {
  /** The line as rsync printed it — what `parseItemizedChanges` returns. */
  raw: string;
  /** The leading flag word (`>f+++++++`, `*deleting`, ...). */
  code: string;
  /** Path relative to the destination, with any ` -> target` suffix removed. */
  path: string;
  /** True when this file does not exist at the destination yet. */
  created: boolean;
}

/**
 * Parse the itemized lines that represent an actual file transfer or delete.
 * rsync `-i` emits a leading code: char 0 is the update type (`>`/`<`/`c`/`*` =
 * transfer/change/delete; `.` = attr-only, skipped) and char 1 is the entry type
 * (`f` file, `d` dir, ...). Directory lines (`d`) are pruned: rsync creates
 * parent dirs as a side effect of transferring files, so counting them would
 * overstate "files changed".
 *
 * `created` is "every attribute slot is `+`", NOT a fixed `+++++++` literal: the
 * flag word is 9 characters on the rsync macOS still ships (2.6.9, `YXcstpogz`)
 * and 11 on rsync 3.x (`YXcstpoguax`). Matching a literal would silently report
 * "nothing is new" on one of the two.
 */
export function parseItemizedEntries(stdout: string): ItemizedChange[] {
  const out: ItemizedChange[] = [];
  for (const line of stdout.split('\n')) {
    const raw = line.trimEnd();
    if (raw.length === 0) continue;
    const code = raw.slice(0, raw.indexOf(' ') === -1 ? raw.length : raw.indexOf(' '));
    const kind = raw[1];
    const type = raw[0];
    if (!(type === '>' || type === '<' || type === 'c' || type === '*') || kind === 'd') continue;
    const rest = raw.slice(code.length).trimStart();
    // `%i %n%L`: a symlink line carries ` -> target`, which is not part of the name.
    const arrow = rest.indexOf(' -> ');
    const path = arrow === -1 ? rest : rest.slice(0, arrow);
    const attrs = code.slice(2);
    const created =
      (type === '>' || type === '<' || type === 'c') &&
      kind === 'f' &&
      attrs.length > 0 &&
      [...attrs].every((c) => c === '+');
    out.push({ raw, code, path, created });
  }
  return out;
}

/** The itemized lines that count as a change, as rsync printed them. */
export function parseItemizedChanges(stdout: string): string[] {
  return parseItemizedEntries(stdout).map((e) => e.raw);
}

/**
 * Workspace-relative paths the registered agents CREATE inside `/workspace` —
 * their own scaffolding rather than the user's content.
 *
 * Derived from the registry (every agent's `clone.drop` and `clone.render`)
 * rather than listed, for the same reason `agentStateExcludePaths` is: an
 * agent's files are the agent's to declare. Unlike that one these are NOT
 * excluded — `download` asks about them when they would be new to the project,
 * and it asks about BOTH halves because both are the agent's scaffolding; only
 * a clone treats them differently.
 */
export function agentWorkspaceArtifactPaths(): string[] {
  const out = new Set<string>();
  for (const spec of AGENT_SYNC_SPECS) {
    for (const rel of spec.clone?.drop ?? []) out.add(rel);
    for (const rel of spec.clone?.render ?? []) out.add(rel);
  }
  return [...out].sort();
}

/**
 * The subset a CLONE drops outright, because the agent regenerates it for the
 * new box. `clone.render` files are deliberately absent: they carry the user's
 * own words and are rewritten for the new bot, not thrown away.
 *
 * Scoped to one agent, and EMPTY when the caller cannot say which: the two
 * mistakes are not symmetric. Keeping a file the agent would regenerate costs
 * nothing -- it regenerates. Dropping one it would not is silent data loss, and
 * the names at stake (`AGENTS.md`, `USER.md`) are exactly what a user writes for
 * themselves. So an unidentified agent drops nothing rather than everything.
 */
export function agentCloneDropPaths(agentId?: string): string[] {
  if (!agentId) return [];
  const specs = AGENT_SYNC_SPECS.filter((s) => s.id === agentId);
  const out = new Set<string>();
  for (const spec of specs) {
    for (const rel of spec.clone?.drop ?? []) out.add(rel);
  }
  return [...out].sort();
}

/**
 * Exact, root-anchored match — deliberately NOT {@link isExcludedPath}, whose
 * bare-name rule matches a basename at any depth and would sweep up a
 * `docs/AGENTS.md` the user wrote themselves.
 */
export function isAgentWorkspaceArtifact(relPath: string, artifacts: readonly string[]): boolean {
  return artifacts.includes(relPath);
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
  /**
   * Paths to drop from `fileList` before copying — the user declined them.
   * Exact, root-anchored matches.
   */
  skipPaths?: readonly string[];
}

/**
 * Which of `paths` actually exist under `scratchDir`.
 *
 * `lstat`, so a symlink counts as present without following it, and the cost is
 * nothing next to `--checksum`, which already reads every byte of every file.
 */
export async function existingPathsIn(
  scratchDir: string,
  paths: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  const LIMIT = 64;
  for (let i = 0; i < paths.length; i += LIMIT) {
    const batch = paths.slice(i, i + LIMIT);
    const found = await Promise.all(
      batch.map(async (rel) => {
        try {
          await lstat(join(scratchDir, rel));
          return rel;
        } catch {
          return null;
        }
      }),
    );
    for (const rel of found) if (rel !== null) out.push(rel);
  }
  return out;
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
): Promise<{ changes: string[]; applied: boolean; missing: string[] }> {
  const baseArgs = ['-a', '--checksum'];
  if (args.fileList === null) {
    for (const e of args.excludes ?? []) baseArgs.push(`--exclude=${e}`);
  } else {
    baseArgs.push('--files-from=-', '--from0');
  }
  const src = `${args.scratchDir}/`;
  const dst = `${args.destDir}/`;

  // A path in `--files-from` that is not in the scratch dir makes rsync exit 23
  // and takes the whole pull down with it, and the rsync macOS ships (2.6.9)
  // does not have `--ignore-missing-args` to soften that. So the list is
  // reconciled with the staged copy here instead.
  //
  // A pull is additive — never `--delete` — so a file that vanished between the
  // listing and the staging is reported and skipped, not fatal. Failing on it
  // would let one racing temp file from a live agent kill a 5000-file download,
  // which is the bug this change removes, wearing a different hat.
  let missing: string[] = [];
  let input = args.fileList !== null ? args.fileList : undefined;
  if (args.fileList !== null) {
    const requested = args.fileList.split('\0').filter((p) => p.length > 0);
    const skip = new Set(args.skipPaths ?? []);
    const wanted = requested.filter((p) => !skip.has(p));
    const present = await existingPathsIn(args.scratchDir, wanted);
    missing = wanted.filter((p) => !present.includes(p));
    // Nothing at all surviving is not a race, it is broken staging — a stale
    // `--no-refresh` scratch dir, or one wiped underneath us. Say so.
    if (present.length === 0 && wanted.length > 0) {
      throw new Error(
        `none of the ${String(wanted.length)} selected file(s) are in the staged copy at ` +
          `${args.scratchDir} — the staging is stale or empty; re-run without --no-refresh`,
      );
    }
    input = present.join('\0');
  }

  const dry = await execa('rsync', [...baseArgs, '--dry-run', '-i', src, dst], {
    reject: false,
    input,
  });
  if (dry.exitCode !== 0) {
    throw new Error(`rsync dry-run failed: ${dry.stderr || dry.stdout}`);
  }
  const changes = parseItemizedChanges(dry.stdout);
  if (args.dryRun) return { changes, applied: false, missing };

  const real = await execa('rsync', [...baseArgs, src, dst], { reject: false, input });
  if (real.exitCode !== 0) {
    throw new Error(`rsync into ${args.destDir} failed: ${real.stderr || real.stdout}`);
  }
  return { changes, applied: true, missing };
}

// ── host → live box (the non-git leg of `agentbox sync`) ──────────────────────

/** What a non-git overlay needs from the box, whatever provider it is on. */
export interface WorkspaceOverlayPorts {
  /**
   * For each relative path, the box's token: absent when the path does not
   * exist, `NON_REGULAR_TOKEN` for a dir/symlink, else the sha256 of the file.
   * Mirrors `WorkspaceResyncPorts.probeUntrackedTokens`.
   *
   * MUST THROW rather than return a partial map. A key missing from the result
   * means "the box does not have this path", and {@link overlayHostDirIntoBox}
   * acts on that by copying the host's file over — so an implementation that
   * degraded to an empty map on failure would overwrite the whole box.
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
      // COPYFILE_DISABLE silences macOS BSD tar's `._*` resource-fork stubs;
      // without it a mac host seeds AppleDouble junk into the box's workspace,
      // which `download` then pulls back. Same guard as `host-export.ts`.
      env: { ...process.env, COPYFILE_DISABLE: '1' },
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
