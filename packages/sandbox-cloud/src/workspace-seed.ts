import { execa } from 'execa';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { detectGitRepos } from '@agentbox/sandbox-core';
import { bashScript, quoteShellArgv } from './shell.js';

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
  onLog?: (line: string) => void;
}

export interface SeedCloudWorkspaceResult {
  /** True when a git repo was found at the workspace root and a clone was used. */
  fromGit: boolean;
  /** Resolved branch (matches `branch` arg). */
  branch: string;
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

  if (root) {
    log(
      nested.length > 0
        ? `seeding /workspace from shallow git clone (+${String(nested.length)} nested repo${nested.length === 1 ? '' : 's'})`
        : 'seeding /workspace from shallow git clone',
    );
    await seedFromGitClone({
      backend: args.backend,
      handle: args.handle,
      hostRepo: root.hostMainRepo,
      branch: args.branch,
      workspaceDir,
      bundleDepth: args.bundleDepth,
      fromBranch: args.fromBranch,
      useBranch: args.useBranch,
      onLog: log,
    });
    // Each nested repo gets its own clone at /workspace/<rel>. We do these
    // after the root clone because the root extract wipes /workspace; a
    // nested dir created during the root checkout (if tracked) would be
    // replaced when we extract over it.
    for (const r of nested) {
      const sub = `${workspaceDir}/${r.relPathFromWorkspace}`;
      log(`seeding nested repo ${r.relPathFromWorkspace} from shallow git clone`);
      await seedFromGitClone({
        backend: args.backend,
        handle: args.handle,
        hostRepo: r.hostMainRepo,
        branch: args.branch,
        workspaceDir: sub,
        bundleDepth: args.bundleDepth,
        onLog: log,
      });
    }
    return { fromGit: true, branch: args.branch };
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

/**
 * Adaptive cap on the host-side shallow clone. Default keeps cold cloud
 * creates fast on big monorepos: clone the last 200 commits; if the tarred
 * `.git/` still exceeds 20 MB, redo at 100. Explicit `bundleDepth` skips
 * the adaptive rebuild (the user picked a number; trust it).
 */
const DEFAULT_BUNDLE_DEPTH = 200;
const LARGE_BUNDLE_DEPTH = 100;
const LARGE_BUNDLE_THRESHOLD_BYTES = 20 * 1024 * 1024;

async function seedFromGitClone(args: SeedFromGitCloneArgs): Promise<void> {
  const log = args.onLog ?? (() => {});
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
  const stashSha = args.useBranch ? null : await safeStashCreate(args.hostRepo);
  const untrackedSize = args.useBranch
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
    await runShallowClone(args.hostRepo, cloneDir, initialDepth, stashRefCreated, cloneBranch);
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
    const carryOverSteps: string[] = stashSha
      ? [
          `if git -C ${quoteShellArgv([args.workspaceDir])} rev-parse --verify ${quoteShellArgv([`refs/remotes/origin/agentbox-carryover/stash`])} >/dev/null 2>&1; then ` +
            `git -C ${quoteShellArgv([args.workspaceDir])} stash apply ${quoteShellArgv([`refs/remotes/origin/agentbox-carryover/stash`])} || ` +
            `echo "agentbox: stash apply soft-failed; carry-over may be incomplete" >&2 ; ` +
            `git -C ${quoteShellArgv([args.workspaceDir])} update-ref -d ${quoteShellArgv([`refs/remotes/origin/agentbox-carryover/stash`])} || true ; ` +
            `fi`,
        ]
      : [];
    if (untrackedSize > 0) {
      carryOverSteps.push(
        `if [ -f ${quoteShellArgv([REMOTE_UNTRACKED_TAR])} ]; then ` +
          `tar -C ${quoteShellArgv([args.workspaceDir])} -xzf ${quoteShellArgv([REMOTE_UNTRACKED_TAR])} && ` +
          `rm -f ${quoteShellArgv([REMOTE_UNTRACKED_TAR])} ; ` +
          `fi`,
      );
    }
    const script = [
      `set -euo pipefail`,
      // Move out of any cwd we might inherit from Daytona's executeCommand
      // before we delete /workspace. The agentbox image bakes WORKDIR
      // /workspace; if the shell's cwd is /workspace when we `rm -rf` it,
      // the next process inherits a stale cwd FD and tar's children fail
      // with "Unable to read current working directory".
      `cd /tmp`,
      SUDO,
      // rm -rf only the directory we're about to extract into — for nested
      // repos this is just `/workspace/<rel>`, so the root clone (already
      // at `/workspace`) is preserved.
      `$SUDO rm -rf ${quoteShellArgv([args.workspaceDir])}`,
      `$SUDO mkdir -p ${quoteShellArgv([args.workspaceDir])}`,
      `$SUDO chown "$(id -un):$(id -gn)" ${quoteShellArgv([args.workspaceDir])}`,
      `tar -C ${quoteShellArgv([args.workspaceDir])} -xzf ${quoteShellArgv([remoteTar])}`,
      setOrigin,
      // reuse: the clone already landed on `<branch>` (pinned via `--branch`);
      // a plain checkout materializes the working tree without resetting the
      // ref. fork: `-B` (re)points `<branch>` at the clone HEAD.
      args.useBranch
        ? `git -C ${quoteShellArgv([args.workspaceDir])} checkout ${quoteShellArgv([args.branch])}`
        : `git -C ${quoteShellArgv([args.workspaceDir])} checkout -B ${quoteShellArgv([args.branch])}`,
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
      `$SUDO rm -rf ${quoteShellArgv([args.workspaceDir])}`,
      `$SUDO mkdir -p ${quoteShellArgv([args.workspaceDir])}`,
      `$SUDO chown "$(id -un):$(id -gn)" ${quoteShellArgv([args.workspaceDir])}`,
      `tar -C ${quoteShellArgv([args.workspaceDir])} -xzf ${quoteShellArgv([remoteTar])}`,
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
