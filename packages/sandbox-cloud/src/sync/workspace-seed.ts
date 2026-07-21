import { execa } from 'execa';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CloudBackend, CloudHandle, ResyncResult } from '@agentbox/core';
import { detectGitRepos } from '@agentbox/sandbox-core';
import { bashScript, quoteShellArgv } from '../shell.js';

/**
 * Seed `/workspace` inside a cloud sandbox from the host workspace. Mirrors
 * what `seedWorkspace` does for the Docker provider, adapted for the cloud
 * channel (`backend.uploadFile` + `backend.exec`):
 *
 *   - Git workspace: `git clone --no-checkout [--depth=N] file://hostRepo`
 *     into a host-side temp dir, tar the resulting `.git/`, upload, extract
 *     into `/workspace`, repoint `origin`, `git checkout -B agentbox/<box>`
 *     to materialize the working tree. Repeats per nested repo for monorepos.
 *   - Non-git workspace: tar the host workspace, upload, extract.
 *
 * Why clone-and-tar instead of `git bundle`? `git bundle create` has no
 * `--depth` flag in any released git version (verified 2.39 and 2.52), and
 * the portable detours all produce bundles with unsatisfiable prerequisites.
 * Shipping a shallow clone is the only way to cap commit count portably.
 */
export interface SeedCloudWorkspaceArgs {
  backend: CloudBackend;
  handle: CloudHandle;
  /** Absolute host path the user passed via `-w`. */
  workspacePath: string;
  /** Branch name to check out inside the sandbox (`agentbox/<box-name>`). */
  branch: string;
  /** In-sandbox destination; defaults to `/workspace`. */
  workspaceDir?: string;
  /**
   * Commit cap for the host-side shallow `git clone`. `undefined` (the
   * common case) → adaptive default: clone the last `DEFAULT_BUNDLE_DEPTH`
   * commits and, if the resulting tar exceeds `LARGE_BUNDLE_THRESHOLD_BYTES`,
   * redo at `LARGE_BUNDLE_DEPTH`. `0` → full history (no `--depth`). `> 0` →
   * fixed shallow depth, no adaptive rebuild. Applied per repo.
   */
  bundleDepth?: number;
  /**
   * Base ref the box's `<branch>` is forked from (default: clone's HEAD).
   * When set, the host clone passes `--branch <fromBranch>` so the clone's
   * HEAD points at the requested ref, and the in-sandbox `git checkout -B
   * <branch>` picks it up. Nested repos keep their own default branch —
   * `<fromBranch>` is applied to the root only. Caller is responsible for
   * validating the ref host-side.
   */
  fromBranch?: string;
  /**
   * Reuse an existing branch directly (root repo only) instead of forking a
   * fresh per-box branch. The host clone pins `--branch <useBranch>` so the
   * clone HEAD lands on it, and the in-sandbox checkout is a plain `git
   * checkout <useBranch>` (no `-B` reset). Mutually exclusive with
   * `fromBranch` (enforced by the CLI). When set, `branch` equals
   * `useBranch`.
   */
  useBranch?: string;
  /**
   * Checkpoint-restore overlay mode. When true, `/workspace` already exists
   * (restored from a snapshot, carrying the checkpoint's gitignored warm
   * artifacts — node_modules, build caches, …). Instead of wiping it, swap
   * only `<repo>/.git` for a fresh host clone, move onto a fresh per-box
   * branch at the host's current base ref (`git checkout -f -B` + `git reset
   * --hard`), and overlay the host's uncommitted/untracked carry-over — the
   * gitignored warm state is left untouched. Non-git workspaces are left as
   * the snapshot baked them (no branch / carry-over concept).
   */
  overlay?: boolean;
  /**
   * Checkpoint-restore only: when true, re-branch to the host target but DON'T
   * replay the host's uncommitted (stash) / untracked carry-over. Set when the
   * user passed `--no-resync` (`resyncOnStart === false`) — mirrors docker's
   * checkpoint restore, which forks the fresh branch but skips
   * `resyncWorkspaceFromHost` when resync is off. Ignored on a fresh seed.
   */
  skipCarryOver?: boolean;
  onLog?: (line: string) => void;
}

export interface SeedCloudWorkspaceResult {
  /** True when a git repo was found at the workspace root and a clone was used. */
  fromGit: boolean;
  /** Resolved branch (matches `branch` arg). */
  branch: string;
  /**
   * Conflicts from an overlay (checkpoint-restore) carry-over, in the shape the
   * CLI's `buildResyncWarning` consumes. Absent on a fresh (non-overlay) seed.
   */
  resync?: ResyncResult;
}

const WORKSPACE_DIR_DEFAULT = '/workspace';

export async function seedCloudWorkspace(
  args: SeedCloudWorkspaceArgs,
): Promise<SeedCloudWorkspaceResult> {
  const workspaceDir = args.workspaceDir ?? WORKSPACE_DIR_DEFAULT;
  const log = args.onLog ?? (() => {});
  const repos = await detectGitRepos(args.workspacePath);
  const root = repos.find((r) => r.kind === 'root');
  const nested = repos.filter((r) => r.kind === 'nested');

  if (!root && args.overlay) {
    // Checkpoint restore of a non-git workspace: there's no branch to fork and
    // no git carry-over to apply, and overlaying a tar would clobber the warm
    // snapshot tree. Keep /workspace exactly as the snapshot baked it.
    log('checkpoint restore: non-git workspace — keeping snapshot /workspace as-is');
    return { fromGit: false, branch: args.branch };
  }

  if (root) {
    log(
      args.overlay
        ? nested.length > 0
          ? `checkpoint restore: re-branching /workspace + ${String(nested.length)} nested repo${nested.length === 1 ? '' : 's'} (warm artifacts kept)`
          : 'checkpoint restore: re-branching /workspace onto a fresh per-box branch (warm artifacts kept)'
        : nested.length > 0
          ? `seeding /workspace from shallow git clone (+${String(nested.length)} nested repo${nested.length === 1 ? '' : 's'})`
          : 'seeding /workspace from shallow git clone',
    );
    const resyncRepos: ResyncResult['repos'] = [];
    const rootConflicts = await reseedRepo({
      backend: args.backend,
      handle: args.handle,
      hostRepo: root.hostMainRepo,
      branch: args.branch,
      workspaceDir,
      bundleDepth: args.bundleDepth,
      fromBranch: args.fromBranch,
      useBranch: args.useBranch,
      overlay: args.overlay,
      skipCarryOver: args.skipCarryOver,
      onLog: log,
    });
    if (args.overlay) resyncRepos.push({ containerPath: workspaceDir, ...rootConflicts });
    // Each nested repo gets its own clone at /workspace/<rel>. We do these
    // after the root clone because the root extract wipes /workspace; a
    // nested dir created during the root checkout (if tracked) would be
    // replaced when we extract over it.
    for (const r of nested) {
      const sub = `${workspaceDir}/${r.relPathFromWorkspace}`;
      log(`seeding nested repo ${r.relPathFromWorkspace} from shallow git clone`);
      const nestedConflicts = await reseedRepo({
        backend: args.backend,
        handle: args.handle,
        hostRepo: r.hostMainRepo,
        branch: args.branch,
        workspaceDir: sub,
        bundleDepth: args.bundleDepth,
        overlay: args.overlay,
        skipCarryOver: args.skipCarryOver,
        onLog: log,
      });
      if (args.overlay) resyncRepos.push({ containerPath: sub, ...nestedConflicts });
    }
    const resync: ResyncResult | undefined = args.overlay
      ? {
          repos: resyncRepos,
          hadConflicts: resyncRepos.some(
            (r) => r.mergeConflicts.length > 0 || r.overlaySkipped.length > 0,
          ),
        }
      : undefined;
    return { fromGit: true, branch: args.branch, resync };
  }

  log('seeding /workspace from workspace tarball (no git detected)');
  await seedFromTar({
    backend: args.backend,
    handle: args.handle,
    hostDir: args.workspacePath,
    workspaceDir,
  });
  return { fromGit: false, branch: args.branch };
}

interface SeedFromGitCloneArgs {
  backend: CloudBackend;
  handle: CloudHandle;
  hostRepo: string;
  branch: string;
  workspaceDir: string;
  /** See `SeedCloudWorkspaceArgs.bundleDepth`. */
  bundleDepth?: number;
  /** See `SeedCloudWorkspaceArgs.fromBranch`. */
  fromBranch?: string;
  /** See `SeedCloudWorkspaceArgs.useBranch`. Root clone only. */
  useBranch?: string;
  /** See `SeedCloudWorkspaceArgs.overlay`. Swap only `.git`, keep the tree. */
  overlay?: boolean;
  /** See `SeedCloudWorkspaceArgs.skipCarryOver`. Re-branch but skip stash/untracked. */
  skipCarryOver?: boolean;
  onLog?: (line: string) => void;
}

/**
 * Temporary host ref used to carry the `git stash create` commit into the
 * shallow clone so the in-sandbox repo can apply it. Created before clone,
 * fetched into the clone under `refs/remotes/origin/<...>` with an explicit
 * refspec, then deleted from the host repo in `finally`.
 */
const STASH_CARRYOVER_REF = 'refs/agentbox-carryover/stash';
const REMOTE_UNTRACKED_TAR = '/tmp/agentbox-carryover-untracked.tar.gz';

// In-box markers the carry-over script prints to stdout so the host can build a
// `ResyncResult`. On a checkpoint restore the box wins every conflict (the host
// change is skipped, never left unmerged) and the skipped path is reported here
// — mirrors docker's `resyncWorkspaceFromHost` so the CLI injects the same
// "conflicting host changes SKIPPED … agentbox-ctl reload" prompt to the agent.
const MERGE_CONFLICT_MARKER = '__AGENTBOX_MERGE_CONFLICT__:';
const OVERLAY_SKIP_MARKER = '__AGENTBOX_OVERLAY_SKIP__:';

/** Per-repo conflict outcome of an overlay (checkpoint-restore) carry-over. */
export interface RepoSeedConflicts {
  mergeConflicts: string[];
  overlaySkipped: string[];
}

export function parseSeedConflicts(stdout: string): RepoSeedConflicts {
  const merge = new Set<string>();
  const overlay = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.startsWith(MERGE_CONFLICT_MARKER)) {
      const p = line.slice(MERGE_CONFLICT_MARKER.length).trim();
      if (p) merge.add(p);
    } else if (line.startsWith(OVERLAY_SKIP_MARKER)) {
      const p = line.slice(OVERLAY_SKIP_MARKER.length).trim();
      if (p) overlay.add(p);
    }
  }
  return { mergeConflicts: [...merge], overlaySkipped: [...overlay] };
}

/**
 * In-box carry-over steps: replay the host's uncommitted (stash) + untracked
 * state onto the freshly checked-out tree. `detectConflicts` (checkpoint
 * restore) makes every collision resolve box-wins and emit a marker:
 *   - stash apply conflict → `git checkout --ours` the unmerged paths (keep the
 *     box's version), report them as MERGE_CONFLICT.
 *   - untracked file already present in the box → skip it (`tar --skip-old-files`)
 *     and report it as OVERLAY_SKIP.
 * Fresh seed (no `detectConflicts`) checks out onto an empty tree, so the simple
 * apply/extract can never collide. Pipes (not `< <(...)`) — the box has no
 * /dev/fd (Vercel/Firecracker). All steps are `-e`-safe.
 */
export function buildCarryOverSteps(opts: {
  workspaceDir: string;
  hasStash: boolean;
  hasUntracked: boolean;
  detectConflicts: boolean;
}): string[] {
  const wd = quoteShellArgv([opts.workspaceDir]);
  const stashRef = quoteShellArgv(['refs/remotes/origin/agentbox-carryover/stash']);
  const untracked = quoteShellArgv([REMOTE_UNTRACKED_TAR]);
  const steps: string[] = [];
  if (opts.hasStash) {
    steps.push(
      opts.detectConflicts
        ? `if git -C ${wd} rev-parse --verify ${stashRef} >/dev/null 2>&1; then ` +
            `if ! git -C ${wd} stash apply ${stashRef} >/dev/null 2>&1; then ` +
            `git -C ${wd} diff --name-only --diff-filter=U | while IFS= read -r p; do [ -n "$p" ] && echo "${MERGE_CONFLICT_MARKER}$p"; done || true ; ` +
            `git -C ${wd} checkout --ours -- . >/dev/null 2>&1 || true ; ` +
            `git -C ${wd} add -A >/dev/null 2>&1 || true ; ` +
            `fi ; ` +
            `git -C ${wd} update-ref -d ${stashRef} || true ; ` +
            `fi`
        : `if git -C ${wd} rev-parse --verify ${stashRef} >/dev/null 2>&1; then ` +
            `git -C ${wd} stash apply ${stashRef} || ` +
            `echo "agentbox: stash apply soft-failed; carry-over may be incomplete" >&2 ; ` +
            `git -C ${wd} update-ref -d ${stashRef} || true ; ` +
            `fi`,
    );
  }
  if (opts.hasUntracked) {
    steps.push(
      opts.detectConflicts
        ? `if [ -f ${untracked} ]; then ` +
            // Report (but don't clobber) untracked files that already exist in
            // the box tree, then extract only the new ones (--skip-old-files).
            `tar -tzf ${untracked} | while IFS= read -r p; do case "$p" in ''|*/) continue ;; esac; if [ -e ${wd}/"$p" ]; then echo "${OVERLAY_SKIP_MARKER}$p"; fi; done || true ; ` +
            `tar -C ${wd} --skip-old-files --no-same-owner -xzf ${untracked} || true ; ` +
            `rm -f ${untracked} ; ` +
            `fi`
        : `if [ -f ${untracked} ]; then ` +
            `tar -C ${wd} --no-same-owner -xzf ${untracked} && rm -f ${untracked} ; ` +
            `fi`,
    );
  }
  return steps;
}

/**
 * Adaptive cap on the host-side shallow clone. Default keeps cold cloud
 * creates fast on big monorepos: clone the last 200 commits; if the tarred
 * `.git/` still exceeds 20 MB, redo at 100. Explicit `bundleDepth` skips
 * the adaptive rebuild (the user picked a number; trust it).
 */
const DEFAULT_BUNDLE_DEPTH = 200;
const LARGE_BUNDLE_DEPTH = 100;
const LARGE_BUNDLE_THRESHOLD_BYTES = 20 * 1024 * 1024;

/**
 * Per-repo seed dispatcher. Fresh create → full shallow clone. Checkpoint
 * restore (`overlay`) → try the incremental delta-bundle path (ship only the
 * host commits the checkpoint's `.git` is missing), falling back to the
 * full-clone overlay (`.git` swap) when the box diverged / the delta isn't
 * computable. Returns the carry-over conflicts (empty for a fresh seed).
 */
async function reseedRepo(args: SeedFromGitCloneArgs): Promise<RepoSeedConflicts> {
  if (args.overlay) {
    const delta = await tryReseedRepoDelta(args);
    if (delta) return delta;
    (args.onLog ?? (() => {}))(
      `checkpoint restore: ${args.workspaceDir}: delta not usable, falling back to full clone`,
    );
  }
  return seedFromGitClone(args);
}

async function seedFromGitClone(args: SeedFromGitCloneArgs): Promise<RepoSeedConflicts> {
  const log = args.onLog ?? (() => {});
  let conflicts: RepoSeedConflicts = { mergeConflicts: [], overlaySkipped: [] };
  const stage = await mkdtemp(join(tmpdir(), 'agentbox-clone-'));
  const cloneDir = join(stage, 'clone');
  const tarPath = join(stage, 'workspace.tar.gz');
  const untrackedTarPath = join(stage, 'untracked.tar.gz');
  // Per-repo carry-over (mirrors `collectRepoCarryOver` from sandbox-docker):
  //   - `git stash create` captures every staged + tracked-modified change
  //     (including deletes/renames) as a one-off commit.
  //   - untracked files get tarred separately because `stash create` (no -u
  //     option) doesn't capture them.
  // The stash commit rides into the shallow clone via an explicit-refspec
  // fetch after the initial clone (HEAD-only clone doesn't pull arbitrary
  // refs). The untracked tar uploads on the side and the in-sandbox script
  // untars it after `git checkout` materializes the working tree.
  //
  // --use-branch skips carry-over entirely: the box gets the reused branch's
  // committed tip, not the host's uncommitted state (which may belong to a
  // different branch). Mirrors the docker reuse path, which builds its
  // RepoCarryOver with `stashSha: null` / empty untracked.
  const stashSha =
    args.useBranch || args.skipCarryOver ? null : await safeStashCreate(args.hostRepo);
  const untrackedSize =
    args.useBranch || args.skipCarryOver
      ? 0
      : await maybeBuildUntrackedTar(args.hostRepo, untrackedTarPath);
  let stashRefCreated = false;
  try {
    if (stashSha) {
      const ref = await execa(
        'git',
        ['-C', args.hostRepo, 'update-ref', STASH_CARRYOVER_REF, stashSha],
        { reject: false },
      );
      stashRefCreated = ref.exitCode === 0;
    }
    // Pick the initial depth.
    //   - undefined → adaptive default (200, may rebuild at 100 if >20 MB)
    //   - 0         → full history (no `--depth` flag)
    //   - N > 0     → fixed shallow depth, no rebuild
    // Shallow history is fine here because `git push` from inside the box
    // travels through the host relay's bundle pull-back, which resolves the
    // merge base against the host repo's full history.
    const configured = args.bundleDepth;
    const adaptive = configured === undefined;
    const initialDepth: number | null = adaptive
      ? DEFAULT_BUNDLE_DEPTH
      : configured === 0
        ? null
        : configured;
    log(
      adaptive
        ? `clone: depth=${String(DEFAULT_BUNDLE_DEPTH)} (default, adaptive)`
        : initialDepth === null
          ? 'clone: depth=full (configured)'
          : `clone: depth=${String(initialDepth)} (configured)`,
    );
    // --use-branch reuses the named branch directly; otherwise --from-branch
    // (or nothing) picks the fork base. Either way it pins the clone's HEAD.
    const cloneBranch = args.useBranch ?? args.fromBranch;
    const lfsRef = cloneBranch ?? 'HEAD';
    await runShallowClone(args.hostRepo, cloneDir, initialDepth, stashRefCreated, cloneBranch);
    // Pack the checkout ref's LFS objects into the clone's .git/lfs BEFORE the
    // tar so the in-box checkout smudges real content (no box network/creds).
    await seedCloneLfsObjects(args.hostRepo, cloneDir, lfsRef, log);
    await tarCloneDir(cloneDir, tarPath);
    if (adaptive && initialDepth !== null) {
      const size = await safeFileSize(tarPath);
      if (size > LARGE_BUNDLE_THRESHOLD_BYTES) {
        const mb = (size / (1024 * 1024)).toFixed(1);
        log(
          `clone tar exceeded ${String(LARGE_BUNDLE_THRESHOLD_BYTES / (1024 * 1024))} MB at depth ${String(DEFAULT_BUNDLE_DEPTH)} (${mb} MB), rebuilding at depth ${String(LARGE_BUNDLE_DEPTH)}`,
        );
        await rm(cloneDir, { recursive: true, force: true });
        await rm(tarPath, { force: true });
        await runShallowClone(args.hostRepo, cloneDir, LARGE_BUNDLE_DEPTH, stashRefCreated, cloneBranch);
        // Fresh cloneDir from the rebuild — re-seed its LFS objects too.
        await seedCloneLfsObjects(args.hostRepo, cloneDir, lfsRef, log);
        await tarCloneDir(cloneDir, tarPath);
      }
    }
    const remoteUrl = await readOriginUrl(args.hostRepo);
    const remoteTar = '/tmp/agentbox-workspace.tar.gz';
    await args.backend.uploadFile(args.handle, tarPath, remoteTar);
    if (untrackedSize > 0) {
      await args.backend.uploadFile(args.handle, untrackedTarPath, REMOTE_UNTRACKED_TAR);
    }
    const setOrigin = remoteUrl
      ? `git -C ${quoteShellArgv([args.workspaceDir])} remote set-url origin ${quoteShellArgv([remoteUrl])}`
      : ': # no host origin to copy';
    // Extract the shallow clone's .git over the destination, then repoint
    // `origin` from the file:// placeholder to the real upstream so future
    // fetch/push target the actual remote (`git push` itself travels back
    // through the host relay). `git checkout -B <branch>` then materializes
    // the working tree from HEAD (the clone was `--no-checkout`, so the
    // tarball only carried `.git/`).
    // /workspace lives at the root in the snapshot — root-owned by default
    // (Dockerfile.box never chowns it). The sandbox runs non-root, so the
    // dir ops need sudo. The devcontainers/base image grants passwordless
    // sudo to `vscode`; SUDO is a no-op when sudo isn't needed/available.
    const SUDO = `if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi`;
    // Stash apply is best-effort — applying onto a possibly shallow clone
    // can hit "needs merge" conflicts in pathological cases (e.g. host had
    // local changes against a commit outside the depth window). Soft-fail
    // is better than blocking provision; any unapplied changes can be
    // re-derived from the host as a fallback.
    const carryOverSteps = buildCarryOverSteps({
      workspaceDir: args.workspaceDir,
      hasStash: Boolean(stashSha),
      hasUntracked: untrackedSize > 0,
      // Conflict detection (box-wins + markers) only matters on a checkpoint
      // restore, where /workspace already has the snapshot's files to collide
      // with. A fresh seed checks out onto an empty tree — nothing to conflict.
      detectConflicts: Boolean(args.overlay),
    });
    // Overlay (checkpoint restore) keeps the snapshot's working tree (its
    // gitignored warm artifacts are the checkpoint's value) and swaps only
    // `<dir>/.git`; the force-checkout + `reset --hard` then move the box onto
    // a fresh per-box branch at the host base ref, dropping the source box's
    // stale TRACKED deviations while leaving untracked/ignored files intact.
    // Fresh seed wipes the dir and materializes the tree from scratch.
    const gitDir = `${args.workspaceDir}/.git`;
    const prepSteps = args.overlay
      ? [`$SUDO rm -rf ${quoteShellArgv([gitDir])}`]
      : [
          ...wipeDirSteps(args.workspaceDir),
          `$SUDO chown "$(id -un):$(id -gn)" ${quoteShellArgv([args.workspaceDir])}`,
        ];
    const checkoutSteps = args.overlay
      ? [
          args.useBranch
            ? `git -C ${quoteShellArgv([args.workspaceDir])} checkout -f ${quoteShellArgv([args.branch])}`
            : `git -C ${quoteShellArgv([args.workspaceDir])} checkout -f -B ${quoteShellArgv([args.branch])}`,
          `git -C ${quoteShellArgv([args.workspaceDir])} reset --hard HEAD`,
        ]
      : [
          // reuse: the clone already landed on `<branch>` (pinned via
          // `--branch`); a plain checkout materializes the working tree without
          // resetting the ref. fork: `-B` (re)points `<branch>` at clone HEAD.
          args.useBranch
            ? `git -C ${quoteShellArgv([args.workspaceDir])} checkout ${quoteShellArgv([args.branch])}`
            : `git -C ${quoteShellArgv([args.workspaceDir])} checkout -B ${quoteShellArgv([args.branch])}`,
        ];
    const script = [
      `set -euo pipefail`,
      // Move out of any cwd we might inherit from Daytona's executeCommand
      // before we delete /workspace. The agentbox image bakes WORKDIR
      // /workspace; if the shell's cwd is /workspace when we `rm -rf` it,
      // the next process inherits a stale cwd FD and tar's children fail
      // with "Unable to read current working directory".
      `cd /tmp`,
      SUDO,
      // Fresh: rm -rf only the dir we extract into (for nested repos that's
      // `/workspace/<rel>`, so the root clone is preserved). Overlay: rm only
      // `<dir>/.git`, preserving the warm working tree.
      ...prepSteps,
      // --no-same-owner (here and on every extraction in this file): clouds
      // whose exec user is root would otherwise preserve the HOST's numeric
      // uids from the tarball, and git then fails with "dubious ownership"
      // on /workspace/.git. Non-root extraction already behaves this way
      // (tar defaults to --no-same-owner unless root).
      `tar -C ${quoteShellArgv([args.workspaceDir])} --no-same-owner -xzf ${quoteShellArgv([remoteTar])}`,
      setOrigin,
      ...checkoutSteps,
      ...carryOverSteps,
      `rm -f ${quoteShellArgv([remoteTar])}`,
    ].join('\n');
    // Daytona's executeCommand shells out via dash (`/bin/sh`), which rejects
    // bash idioms like `set -o pipefail`. Wrap in `bash -c` so the script
    // runs in bash regardless of what `/bin/sh` points at.
    const r = await args.backend.exec(args.handle, bashScript(script));
    if (r.exitCode !== 0) {
      throw new Error(`workspace seed (clone) failed: ${r.stderr || r.stdout}`);
    }
    if (args.overlay) conflicts = parseSeedConflicts(r.stdout);
  } finally {
    // Defensive cleanup of the temp stash ref on host. If we threw between
    // updates, the ref may still be present; delete it so re-runs don't
    // accrue refs/agentbox-carryover/* entries.
    if (stashRefCreated) {
      await execa('git', ['-C', args.hostRepo, 'update-ref', '-d', STASH_CARRYOVER_REF], {
        reject: false,
      });
    }
    await rm(stage, { recursive: true, force: true });
  }
  return conflicts;
}

const DELTA_TARGET_REF = 'refs/agentbox-delta/target';
const REMOTE_DELTA_BUNDLE = '/tmp/agentbox-delta.bundle';
const REMOTE_DELTA_LFS = '/tmp/agentbox-delta-lfs.tar.gz';
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Incremental checkpoint-restore for one repo: instead of re-cloning the whole
 * history, ship only the commits the snapshot's `/workspace/.git` is MISSING
 * (`checkpointTip..hostTarget`) as a git bundle, fetch them into the existing
 * `.git`, then move onto the fresh per-box branch at the host target and replay
 * carry-over. Returns the carry-over conflicts on success, or `null` to signal
 * the caller to fall back to a full-clone overlay (box diverged / tip unknown /
 * bundle build failed). Drops the checkpoint's own tracked commits by resetting
 * to the host target — matching docker.
 */
async function tryReseedRepoDelta(args: SeedFromGitCloneArgs): Promise<RepoSeedConflicts | null> {
  const log = args.onLog ?? (() => {});
  const wd = quoteShellArgv([args.workspaceDir]);

  // 1. The commit the snapshot's /workspace/.git is parked at.
  const tipRes = await args.backend.exec(
    args.handle,
    bashScript(`git -C ${wd} rev-parse HEAD 2>/dev/null || true`),
  );
  const checkpointTip = tipRes.stdout.trim();
  if (!SHA_RE.test(checkpointTip)) return null; // not a git repo / detached weirdness

  // 2. The host fork base (same ref the fresh seed forks from).
  const baseRef = args.useBranch ?? args.fromBranch ?? 'HEAD';
  const targetRes = await execa('git', ['-C', args.hostRepo, 'rev-parse', baseRef], {
    reject: false,
  });
  const target = targetRes.stdout.trim();
  if (targetRes.exitCode !== 0 || !SHA_RE.test(target)) return null;

  // 3. Delta is only valid when the host still has checkpointTip AND it's an
  //    ancestor of the target (otherwise the box diverged → full-clone reset).
  const hasTip = await execa(
    'git',
    ['-C', args.hostRepo, 'cat-file', '-e', `${checkpointTip}^{commit}`],
    { reject: false },
  );
  if (hasTip.exitCode !== 0) return null;
  const ancestor = await execa(
    'git',
    ['-C', args.hostRepo, 'merge-base', '--is-ancestor', checkpointTip, target],
    { reject: false },
  );
  if (ancestor.exitCode !== 0) return null;

  const stage = await mkdtemp(join(tmpdir(), 'agentbox-delta-'));
  const bundlePath = join(stage, 'delta.bundle');
  const untrackedTarPath = join(stage, 'untracked.tar.gz');
  const deltaLfsTarPath = join(stage, 'delta-lfs.tar.gz');
  // --use-branch reuses the committed tip; no host uncommitted carry-over.
  const stashSha =
    args.useBranch || args.skipCarryOver ? null : await safeStashCreate(args.hostRepo);
  const untrackedSize =
    args.useBranch || args.skipCarryOver
      ? 0
      : await maybeBuildUntrackedTar(args.hostRepo, untrackedTarPath);
  let stashRefCreated = false;
  try {
    if (stashSha) {
      const ref = await execa(
        'git',
        ['-C', args.hostRepo, 'update-ref', STASH_CARRYOVER_REF, stashSha],
        { reject: false },
      );
      stashRefCreated = ref.exitCode === 0;
    }
    const needTarget = target !== checkpointTip;
    if (needTarget) {
      await execa('git', ['-C', args.hostRepo, 'update-ref', DELTA_TARGET_REF, target], {
        reject: false,
      });
    }
    // Bundle the refs the box lacks, excluding everything it already has
    // (`^checkpointTip` — the box holds this, so the bundle's prerequisite is
    // satisfiable even though its .git is shallow).
    const bundleRefs: string[] = [];
    if (needTarget) bundleRefs.push(DELTA_TARGET_REF);
    if (stashRefCreated) bundleRefs.push(STASH_CARRYOVER_REF);
    let haveBundle = false;
    if (bundleRefs.length > 0) {
      const b = await execa(
        'git',
        ['-C', args.hostRepo, 'bundle', 'create', bundlePath, ...bundleRefs, `^${checkpointTip}`],
        { reject: false },
      );
      if (b.exitCode !== 0) return null; // unexpected → fall back to full clone
      haveBundle = true;
      await args.backend.uploadFile(args.handle, bundlePath, REMOTE_DELTA_BUNDLE);
    }
    if (untrackedSize > 0) {
      await args.backend.uploadFile(args.handle, untrackedTarPath, REMOTE_UNTRACKED_TAR);
    }
    // Ship the LFS objects the delta introduces (oids in target but not in the
    // checkpoint tip the box already holds), so the post-restore checkout
    // smudges new LFS files to real content. Bounded + best-effort.
    const deltaLfsSize = await maybeBuildDeltaLfsTar(
      args.hostRepo,
      target,
      checkpointTip,
      deltaLfsTarPath,
    );
    if (deltaLfsSize > 0) {
      await args.backend.uploadFile(args.handle, deltaLfsTarPath, REMOTE_DELTA_LFS);
      log(
        `checkpoint restore: ${args.workspaceDir}: ${String(deltaLfsSize)} B of new git-lfs objects`,
      );
    }
    log(
      needTarget
        ? `checkpoint restore: ${args.workspaceDir}: delta bundle (${checkpointTip.slice(0, 8)}..${target.slice(0, 8)})`
        : `checkpoint restore: ${args.workspaceDir}: no new host commits; re-branch + carry-over only`,
    );

    const remoteUrl = await readOriginUrl(args.hostRepo);
    const setOrigin = remoteUrl
      ? `git -C ${wd} remote set-url origin ${quoteShellArgv([remoteUrl])}`
      : ': # no host origin to copy';
    const fetchRefspecs: string[] = [];
    if (needTarget) fetchRefspecs.push(`+${DELTA_TARGET_REF}:${DELTA_TARGET_REF}`);
    if (stashRefCreated)
      fetchRefspecs.push(`+${STASH_CARRYOVER_REF}:refs/remotes/origin/agentbox-carryover/stash`);
    const fetchStep =
      haveBundle && fetchRefspecs.length > 0
        ? `git -C ${wd} fetch --no-tags ${quoteShellArgv([REMOTE_DELTA_BUNDLE])} ${fetchRefspecs.map((s) => quoteShellArgv([s])).join(' ')}`
        : ': # no delta bundle to fetch';
    // Box ends at the host target SHA (drop the checkpoint's own commits), on a
    // fresh per-box branch; gitignored warm artifacts are untouched by checkout/reset.
    const checkoutStep = args.useBranch
      ? `git -C ${wd} checkout -f ${quoteShellArgv([args.branch])}`
      : `git -C ${wd} checkout -f -B ${quoteShellArgv([args.branch])} ${quoteShellArgv([target])}`;
    const carryOverSteps = buildCarryOverSteps({
      workspaceDir: args.workspaceDir,
      hasStash: Boolean(stashSha),
      hasUntracked: untrackedSize > 0,
      detectConflicts: true,
    });
    // Extract the delta's new LFS objects into the box's object store BEFORE the
    // checkout/reset smudges them. `.git/lfs/objects/aa/bb/<oid>` layout is
    // preserved by the tar so they land content-addressed.
    const lfsStep =
      deltaLfsSize > 0
        ? `tar -C ${quoteShellArgv([`${args.workspaceDir}/.git`])} --no-same-owner -xzf ${quoteShellArgv([REMOTE_DELTA_LFS])}`
        : ': # no delta lfs objects';
    const SUDO = `if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi`;
    const script = [
      `set -euo pipefail`,
      `cd /tmp`,
      SUDO,
      fetchStep,
      lfsStep,
      checkoutStep,
      `git -C ${wd} reset --hard ${quoteShellArgv([target])}`,
      setOrigin,
      ...carryOverSteps,
      `git -C ${wd} update-ref -d ${quoteShellArgv([DELTA_TARGET_REF])} || true`,
      `rm -f ${quoteShellArgv([REMOTE_DELTA_BUNDLE])} ${quoteShellArgv([REMOTE_DELTA_LFS])}`,
    ].join('\n');
    const r = await args.backend.exec(args.handle, bashScript(script));
    if (r.exitCode !== 0) {
      // The box's .git is intact (we only fetched + checked out); a clean
      // fall-back to the full-clone overlay can still recover.
      log(`checkpoint restore: ${args.workspaceDir}: delta apply failed, falling back: ${r.stderr || r.stdout}`);
      return null;
    }
    return parseSeedConflicts(r.stdout);
  } finally {
    if (stashRefCreated) {
      await execa('git', ['-C', args.hostRepo, 'update-ref', '-d', STASH_CARRYOVER_REF], {
        reject: false,
      });
    }
    await execa('git', ['-C', args.hostRepo, 'update-ref', '-d', DELTA_TARGET_REF], {
      reject: false,
    });
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Shallow `git clone --no-checkout` into `cloneDir`. `depth === null` → full
 * history (no `--depth` flag). When the host carries a stash ref, that ref
 * is explicitly fetched into the new clone under `refs/remotes/origin/...`
 * with a matching `--depth`, so the in-box `stash apply` can find it.
 *
 * `--no-checkout` skips materializing the working tree on host (we'd just
 * throw it away when we tar `.git/`). `file://` is required so git treats
 * the source as a remote — without it, `git clone <local-path>` uses object
 * hardlinks and silently ignores `--depth`, producing a full clone.
 */
async function runShallowClone(
  hostRepo: string,
  cloneDir: string,
  depth: number | null,
  includeStashRef: boolean,
  fromBranch?: string,
): Promise<void> {
  const cloneArgs: string[] = ['clone', '--no-checkout', '--quiet'];
  if (depth !== null) cloneArgs.push(`--depth=${String(depth)}`);
  // `--branch` pins the clone's HEAD to the requested ref so the in-sandbox
  // `git checkout -B <branch>` picks up that ref as the fork point. Accepts
  // branch names + tags; SHAs aren't supported by `git clone --branch` and
  // would need a separate fetch (callers using SHAs should validate
  // host-side and pass a branch/tag name instead, or skip --from-branch).
  if (fromBranch) cloneArgs.push('--branch', fromBranch);
  cloneArgs.push(`file://${hostRepo}`, cloneDir);
  await execa('git', cloneArgs);
  if (includeStashRef) {
    // Soft-fail: the stash commit's parents could in principle fall outside
    // a very shallow window; the in-box `stash apply` already soft-fails,
    // so missing the ref here is equivalent.
    const fetchArgs: string[] = ['-C', cloneDir, 'fetch', '--quiet'];
    if (depth !== null) fetchArgs.push(`--depth=${String(depth)}`);
    fetchArgs.push(
      `file://${hostRepo}`,
      `+${STASH_CARRYOVER_REF}:refs/remotes/origin/agentbox-carryover/stash`,
    );
    await execa('git', fetchArgs, { reject: false });
  }
}

async function tarCloneDir(cloneDir: string, outPath: string): Promise<void> {
  await execa('tar', ['-C', cloneDir, '-czf', outPath, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
}

const LFS_OID_RE = /^[0-9a-f]{64}$/;

/** Content-addressed path of an LFS object inside a `.git/` dir: `lfs/objects/aa/bb/<oid>`. */
export function lfsObjectRelPath(oid: string): string {
  return join('lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
}

/**
 * The set of LFS object oids reachable from `ref` in `hostRepo`. Empty when the
 * repo doesn't use LFS, `ref` is unknown, or git-lfs isn't installed on the host
 * (all best-effort — never throws). `git lfs ls-files --long` prints
 * "<oid> <* or -> <path>" per tracked blob.
 */
async function lfsOidsForRef(hostRepo: string, ref: string): Promise<string[]> {
  const listed = await execa('git', ['-C', hostRepo, 'lfs', 'ls-files', '--long', ref], {
    reject: false,
  });
  if (listed.exitCode !== 0) return [];
  const oids = listed.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((o) => LFS_OID_RE.test(o));
  return [...new Set(oids)];
}

/**
 * Pack the LFS objects reachable from `ref` into the shallow clone's
 * `.git/lfs/objects/` BEFORE it's tarred, so the in-box `git checkout` smudges
 * real content instead of leaving pointer files. Docker gets this for free via
 * its bind-mounted shared `.git/lfs`; cloud has no bind mount, so we copy the
 * content-addressed blobs into the clone where they ride the existing workspace
 * tar (no box network / credentials needed at checkout).
 *
 * Bounded + best-effort, mirroring the docker provider's `prefetchHostLfs`:
 *   - probe `git lfs ls-files` → a non-LFS repo does nothing, no log noise.
 *   - `git lfs fetch origin <ref>` (host holds the creds) warms the host cache.
 *   - copy ONLY the ref's oids (not the whole `.git/lfs` cache, which can be
 *     GBs) into the clone. A missing oid (fetch failed / offline) is left as a
 *     pointer — the box still seeds, just without that object's content.
 */
async function seedCloneLfsObjects(
  hostRepo: string,
  cloneDir: string,
  ref: string,
  log: (line: string) => void,
): Promise<void> {
  // Cheap probe so the overwhelmingly common non-LFS repo does nothing and logs
  // nothing. Empty stdout or non-zero exit (no git-lfs binary / not LFS) → skip.
  const tracked = await execa('git', ['-C', hostRepo, 'lfs', 'ls-files', '-n', ref], {
    reject: false,
  });
  if (tracked.exitCode !== 0 || tracked.stdout.trim().length === 0) return;

  // Warm the host object cache for the checkout ref (uses the host's creds).
  const fetched = await execa('git', ['-C', hostRepo, 'lfs', 'fetch', 'origin', ref], {
    reject: false,
  });
  if (fetched.exitCode !== 0) {
    const msg = (fetched.stderr || fetched.stdout || `exit ${String(fetched.exitCode ?? '?')}`)
      .trim()
      .split('\n')[0];
    log(`git-lfs prefetch for ${ref} skipped (best-effort, continuing): ${msg}`);
  }

  const oids = await lfsOidsForRef(hostRepo, ref);
  let copied = 0;
  for (const oid of oids) {
    const rel = lfsObjectRelPath(oid);
    const dst = join(cloneDir, '.git', rel);
    try {
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(join(hostRepo, '.git', rel), dst);
      copied++;
    } catch {
      // Object isn't in the host cache (fetch missed / offline) — leave the
      // pointer; the box surfaces it as a pointer rather than failing the seed.
    }
  }
  if (copied > 0) log(`seeded ${String(copied)} git-lfs object(s) for ${ref} into clone`);
}

/**
 * Tar the LFS objects that the checkpoint restore's delta introduces — the oids
 * reachable from `target` but not from `checkpointTip` (which the box already
 * has from when it was first seeded). Preserves the `lfs/objects/aa/bb/<oid>`
 * layout so an in-box `tar -x` into `<workspaceDir>/.git` lands them in the
 * box's object store. Returns the tar size (0 when there's nothing to ship, so
 * the caller can skip the upload + extract). Best-effort; never throws.
 */
async function maybeBuildDeltaLfsTar(
  hostRepo: string,
  target: string,
  checkpointTip: string,
  outPath: string,
): Promise<number> {
  const targetOids = await lfsOidsForRef(hostRepo, target);
  if (targetOids.length === 0) return 0;
  const have = new Set(await lfsOidsForRef(hostRepo, checkpointTip));
  const deltaOids = targetOids.filter((o) => !have.has(o));
  if (deltaOids.length === 0) return 0;

  // Warm the host cache for the target ref, then keep only the oids whose blob
  // actually exists on disk (a missed fetch just ships fewer objects).
  await execa('git', ['-C', hostRepo, 'lfs', 'fetch', 'origin', target], { reject: false });
  const gitDir = join(hostRepo, '.git');
  const relPaths: string[] = [];
  for (const oid of deltaOids) {
    const rel = lfsObjectRelPath(oid);
    try {
      await stat(join(gitDir, rel));
      relPaths.push(rel);
    } catch {
      // not present — skip
    }
  }
  if (relPaths.length === 0) return 0;
  const tar = await execa('tar', ['-C', gitDir, '-czf', outPath, ...relPaths], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    reject: false,
  });
  if (tar.exitCode !== 0) return 0;
  return safeFileSize(outPath);
}

async function safeFileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Best-effort `git stash create` on the host repo. Returns the stash SHA
 * (or `null` when the worktree is clean / git is missing / the call fails).
 * Mirrors the docker provider's `collectRepoCarryOver` shape — pure host
 * git, no side effects on the working tree.
 */
async function safeStashCreate(hostRepo: string): Promise<string | null> {
  const r = await execa('git', ['-C', hostRepo, 'stash', 'create'], { reject: false });
  if (r.exitCode !== 0) return null;
  const sha = r.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Tar the repo's untracked-not-ignored files into `outPath`. Returns the
 * tar size in bytes (0 when there's nothing to tar, so callers can skip
 * the upload). `git stash create` doesn't capture untracked, so the carry-
 * over needs this side channel — matches docker's behavior.
 */
async function maybeBuildUntrackedTar(hostRepo: string, outPath: string): Promise<number> {
  const list = await execa(
    'git',
    ['-C', hostRepo, 'ls-files', '--others', '--exclude-standard', '-z'],
    { reject: false },
  );
  if (list.exitCode !== 0 || list.stdout.length === 0) return 0;
  // Feed NUL-delimited paths to `tar --null -T -` so spaces / quotes /
  // newlines in filenames survive. Use COPYFILE_DISABLE=1 to suppress
  // macOS' AppleDouble `._<name>` sidecars (same hardening as the
  // agent-credential tarballs).
  const tar = await execa(
    'tar',
    ['-C', hostRepo, '--null', '-T', '-', '-czf', outPath],
    {
      input: list.stdout,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      reject: false,
    },
  );
  if (tar.exitCode !== 0) return 0;
  try {
    const { stat } = await import('node:fs/promises');
    const s = await stat(outPath);
    return s.size;
  } catch {
    return 0;
  }
}

async function readOriginUrl(hostRepo: string): Promise<string | null> {
  const r = await execa('git', ['-C', hostRepo, 'remote', 'get-url', 'origin'], { reject: false });
  if (r.exitCode !== 0) return null;
  const out = (r.stdout ?? '').trim();
  return out.length > 0 ? out : null;
}

/**
 * Fresh-seed wipe of the extraction dir. Clears the dir's contents instead of
 * `rm -rf`-ing the dir itself: some clouds mount the workspace dir into the
 * sandbox, so removing it fails with "Device or resource busy". Expects the
 * caller's script to have defined `$SUDO`.
 */
function wipeDirSteps(dir: string): string[] {
  const q = quoteShellArgv([dir]);
  return [`$SUDO mkdir -p ${q}`, `$SUDO find ${q} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`];
}

interface SeedFromTarArgs {
  backend: CloudBackend;
  handle: CloudHandle;
  hostDir: string;
  workspaceDir: string;
}

async function seedFromTar(args: SeedFromTarArgs): Promise<void> {
  const stage = await mkdtemp(join(tmpdir(), 'agentbox-tar-'));
  const tarPath = join(stage, 'workspace.tar.gz');
  try {
    await execa('tar', ['-C', args.hostDir, '-czf', tarPath, '.']);
    const remoteTar = '/tmp/agentbox-workspace.tar.gz';
    await args.backend.uploadFile(args.handle, tarPath, remoteTar);
    const SUDO = `if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi`;
    const script = [
      `set -euo pipefail`,
      // Move out of any cwd we might inherit from Daytona's executeCommand
      // before we delete /workspace. The agentbox image bakes WORKDIR
      // /workspace; if the shell's cwd is /workspace when we `rm -rf` it,
      // the next process inherits a stale cwd FD and git-clone's child
      // (index-pack) fails with "Unable to read current working directory".
      `cd /tmp`,
      SUDO,
      ...wipeDirSteps(args.workspaceDir),
      `$SUDO chown "$(id -un):$(id -gn)" ${quoteShellArgv([args.workspaceDir])}`,
      `tar -C ${quoteShellArgv([args.workspaceDir])} --no-same-owner -xzf ${quoteShellArgv([remoteTar])}`,
      `rm -f ${quoteShellArgv([remoteTar])}`,
    ].join('\n');
    const r = await args.backend.exec(args.handle, bashScript(script));
    if (r.exitCode !== 0) {
      throw new Error(`workspace seed (tar) failed: ${r.stderr || r.stdout}`);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
