import { execa } from 'execa';
import { execInBox } from './docker.js';
import type { DetectedGitRepo } from './git-worktree.js';
import { GitWorktreeError } from './git-worktree.js';

/**
 * Root for per-box git-worktree directories inside the container. Each box
 * registers its worktree at a unique subpath here so the host main repo's
 * worktree registry can list multiple concurrent boxes without path
 * collision; `/workspace` is then a symlink to the per-box dir. Lives under
 * the vscode user's home so it's writable without sudo. Exported for the
 * fs-safe path helper.
 */
export const WORKTREE_ROOT = '/home/vscode/.agentbox-worktrees';

/** Sanitize a branch name into an FS-safe path segment. */
export function fsSafeBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/**
 * Per-box per-repo path at which `git worktree add` registers the worktree
 * inside the container. The agent's working tree path stays `/workspace`
 * (root) / `/workspace/<sub>` (nested) via symlinks created after the add.
 * Unique because the branch name carries the box name, so the host main
 * repo never sees a path collision when multiple boxes from the same
 * project run concurrently.
 */
export function gitWorktreePathFor(branch: string): string {
  return `${WORKTREE_ROOT}/${fsSafeBranch(branch)}`;
}

/**
 * Per-repo carry-over captured on the host before the container starts. The
 * host runs the `git stash create` + `ls-files --others` here against the
 * user's main checkout, then `seedWorkspace` replays both inside the box.
 *
 * `stashSha` and the untracked tarball are stored in the shared `.git/`
 * object database (stash) and as a buffer (untracked) so the container can
 * apply them after `git worktree add` runs against the bind-mounted `.git`.
 */
export interface RepoCarryOver {
  repo: DetectedGitRepo;
  /**
   * Agent-visible container path of the worktree (`/workspace` for root,
   * `/workspace/<sub>` for nested). After seedWorkspace runs this is a
   * symlink to `gitWorktreePath`.
   */
  containerPath: string;
  /**
   * Real container path where git registered the worktree
   * (`/home/vscode/.agentbox-worktrees/<fsSafeBranch>`). Per-box unique, so
   * concurrent boxes from the same project don't collide in the host main
   * repo's worktree registry.
   */
  gitWorktreePath: string;
  /** Branch name to pass to `git worktree add -b`. */
  branch: string;
  /** Stash-commit SHA (`git stash create`); null when the host main was clean. */
  stashSha: string | null;
  /**
   * NUL-separated list of repo-relative untracked paths. We tar these up
   * host-side and pipe them in inside seedWorkspace. Empty when no untracked
   * files.
   */
  untrackedNul: string;
  /** Host dir to tar from (== repo.hostMainRepo, kept here so seedWorkspace doesn't need to know about the repo shape). */
  hostSource: string;
  /**
   * Reuse the existing branch `<branch>` instead of forking a fresh one:
   * `git worktree add <wt> <branch>` (no `-b`, no base ref). Set by the
   * `--use-branch` path for the root repo. When unset/false the worktree is
   * created with `-b <branch>` from `fromBranch ?? HEAD` (the default fork).
   */
  reuseBranch?: boolean;
}

/**
 * Collect host-side state for each detected repo so it can be replayed
 * inside the container by `seedWorkspace`. Pure of any docker calls — every
 * shell-out is host git.
 *
 * Branch picking is left to the caller (so it can be allocated before
 * `docker run` and recorded on the BoxRecord regardless of how the rest of
 * create proceeds).
 */
export async function collectRepoCarryOver(
  repo: DetectedGitRepo,
  branch: string,
  containerPath: string,
  gitWorktreePath: string,
): Promise<RepoCarryOver> {
  // `stash create` writes a stash commit without touching the working tree or
  // stash list; empty output = clean. The commit lands in the host's `.git/`
  // object DB, which is bind-mounted into the container — so the in-box
  // worktree can `stash apply <sha>` against it.
  const stash = await execa('git', ['-C', repo.hostMainRepo, 'stash', 'create'], { reject: false });
  const stashSha = stash.exitCode === 0 ? stash.stdout.trim() || null : null;

  const untracked = await execa(
    'git',
    ['-C', repo.hostMainRepo, 'ls-files', '--others', '--exclude-standard', '-z'],
    { reject: false },
  );
  const untrackedNul = untracked.exitCode === 0 ? untracked.stdout : '';

  return {
    repo,
    containerPath,
    gitWorktreePath,
    branch,
    stashSha,
    untrackedNul,
    hostSource: repo.hostMainRepo,
  };
}

export interface SeedWorkspaceOptions {
  container: string;
  /** Repos with collected carry-over, in DAG order: root first, nested after. */
  repos: RepoCarryOver[];
  /**
   * Base ref each worktree is forked from. `undefined` (default) → `HEAD`.
   * Caller validates host-side; passed verbatim to `git worktree add`. Set
   * by `agentbox create --from-branch <ref>` so the box can start from main
   * (or any ref) instead of whatever the host happens to have checked out.
   */
  fromBranch?: string;
  onLog?: (line: string) => void;
}

/**
 * docker exec helper that throws GitWorktreeError on non-zero exit. `cwd`
 * defaults to `/` so callers that intentionally rebind `/workspace` (the
 * image's WORKDIR) don't get hit by "chdir failed: no such file or directory"
 * on the next exec.
 */
async function dexec(
  container: string,
  argv: string[],
  user: 'vscode' | 'root' = 'vscode',
  cwd: string = '/',
): Promise<void> {
  const r = await execa(
    'docker',
    ['exec', '-w', cwd, '--user', user, container, ...argv],
    { reject: false },
  );
  if (r.exitCode !== 0) {
    throw new GitWorktreeError(`${argv.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
}

/**
 * Minimum shape `bindWorktrees` needs — keeps the helper independent of
 * the `RepoCarryOver` / `GitWorktreeRecord` types so both `seedWorkspace`
 * (after creation) and `startBox` (after `docker start`) can call it.
 */
export interface WorktreeBindSpec {
  kind: 'root' | 'nested';
  containerPath: string;
  gitWorktreePath: string;
}

/**
 * Apply the `/workspace` (and `/workspace/<sub>`) bind mounts that expose
 * each per-box git worktree at its canonical agent path.
 *
 * Idempotent for `startBox` re-runs: if the target is already a mountpoint
 * we unmount it first. Root bind first so the nested mount points (created
 * by the root worktree's `worktree add`) exist before we cover them.
 *
 * The mount runs as `root` because `mount(2)` requires `CAP_SYS_ADMIN` —
 * which we already grant the outer container for the in-box dockerd. The
 * bind itself respects file ownership on the source side (vscode-owned),
 * so subsequent in-container operations under `/workspace` work as vscode.
 */
/**
 * Make the in-container parent directory of each bind-mounted `.git` owned by
 * `vscode`. Docker auto-creates the intermediate path for a bind mount
 * (e.g. `/Users/marco/Projects/Foo/` for a `.git` at `/Users/marco/Projects/Foo/.git`)
 * in the container's writable layer as `root:root 755`. The bind-mounted
 * `.git` itself keeps its host UIDs, but agents (turborepo, build caches,
 * etc.) often want to write *siblings* of `.git` at the project root —
 * `.turbo/`, `.next/`, scratch files — which fails as `vscode` if the parent
 * is root-owned. This flips just that parent dir's UID.
 *
 * NOT recursive on purpose: `chown -R` would descend into `.git` (the
 * bind-mount inode) and propagate ownership changes back to the host,
 * defeating the "no host perms touched" property.
 *
 * Best-effort: failures are logged, not thrown — the box still functions,
 * only sibling writes at the project root are affected.
 */
export async function chownGitBindParents(args: {
  container: string;
  hostMainRepos: string[];
  onLog?: (line: string) => void;
}): Promise<void> {
  const log = args.onLog ?? (() => {});
  // Dedupe — nested-repo carry-overs can repeat hostMainRepo.
  const repos = Array.from(new Set(args.hostMainRepos));
  for (const repo of repos) {
    const result = await execInBox(args.container, ['chown', 'vscode:vscode', repo], {
      user: 'root',
    });
    if (result.exitCode === 0) {
      log(`chowned ${repo} to vscode:vscode (parent of bind-mounted .git)`);
    } else {
      const msg = (result.stderr || result.stdout || `exit ${result.exitCode}`).trim();
      log(`chown ${repo} failed (best-effort, ignoring): ${msg}`);
    }
  }
}

export async function bindWorktrees(
  container: string,
  binds: WorktreeBindSpec[],
  onLog?: (line: string) => void,
): Promise<void> {
  const log = onLog ?? (() => {});
  // Root first; nested mountpoints live inside the root worktree's tree so
  // the root bind has to be in place before we cover sub-paths.
  const ordered = [...binds].sort((a, b) =>
    a.kind === 'root' && b.kind !== 'root' ? -1 : a.kind !== 'root' && b.kind === 'root' ? 1 : 0,
  );
  for (const b of ordered) {
    // Best-effort unmount of any leftover bind at the target (idempotent for
    // startBox: container stop drops mounts, but a partial create might
    // leave one in place).
    await execa(
      'docker',
      ['exec', '-w', '/', '--user', 'root', container, 'sh', '-c', `mountpoint -q ${b.containerPath} && umount ${b.containerPath} || true`],
      { reject: false },
    );
    // For nested: parent must exist. The root bind exposes the root
    // worktree's tracked tree, which typically contains <sub>/, but if the
    // root .gitignores it or the nested repo is in a fresh path, mkdir is
    // needed.
    if (b.kind === 'nested') {
      await dexec(container, ['mkdir', '-p', ctParent(b.containerPath)], 'root');
      await dexec(container, ['mkdir', '-p', b.containerPath], 'root');
    }
    await dexec(container, ['mount', '--bind', b.gitWorktreePath, b.containerPath], 'root');
    log(`bind-mounted ${b.containerPath} <- ${b.gitWorktreePath}`);
  }
}

/**
 * Materialize each per-box git worktree *inside* the container against the
 * bind-mounted `.git/`, then replay the host's uncommitted state (stash +
 * untracked) into it. Runs as `vscode` (the in-container user) so files in
 * /workspace are owned by uid 1000.
 *
 * Layout: every worktree is registered at a per-box unique path under
 * `WORKTREE_ROOT` (`/home/vscode/.agentbox-worktrees/<fsSafeBranch>`), then
 * a `mount --bind` exposes it at `/workspace` (and `/workspace/<sub>` for
 * nested repos). The uniqueness is load-bearing — the host main repo's
 * worktree registry is keyed by absolute path, so multiple concurrent
 * boxes from the same project must register at *different* paths. They
 * share the object DB (the bind-mounted `.git/`) but have independent
 * HEAD/index in their own `.git/worktrees/<subdir>`.
 *
 * The bind mount (not a symlink) is intentional: getcwd() / realpath() /
 * git rev-parse --show-toplevel / Node's process.cwd() all return
 * `/workspace`. A symlink would leak the per-box physical path everywhere
 * tools canonicalize. Cost: the mount is per-container-namespace and
 * doesn't survive `docker stop`, so `startBox` re-binds via
 * {@link bindWorktrees}. Host's `git worktree list` will show each box's
 * registered path as `/home/vscode/.agentbox-worktrees/...` (container-only
 * — host marks it `prunable`, which is harmless).
 */
export async function seedWorkspace(opts: SeedWorkspaceOptions): Promise<void> {
  const log = opts.onLog ?? (() => {});

  // Ensure the per-box worktree root exists. Idempotent — multiple boxes
  // can be created in parallel against the same image.
  await dexec(opts.container, ['mkdir', '-p', WORKTREE_ROOT]);

  // Phase 1: register each worktree at its per-box unique path.
  // `fromBranch` (when set) overrides the default `HEAD` base ref for the
  // *root* repo only — the CLI's `--from-branch <ref>` is resolved against
  // the user's primary repo, and a nested submodule/monorepo-sub-repo will
  // almost never carry that same ref. Applying it uniformly would fail
  // `git worktree add` for nested repos that don't have `<ref>`, aborting
  // box creation. Mirrors the cloud path's behavior in
  // `packages/sandbox-cloud/src/workspace-seed.ts` (which only forwards
  // `fromBranch` to the root clone).
  for (const r of opts.repos) {
    const main = r.repo.hostMainRepo;
    const wt = r.gitWorktreePath;
    // reuse: check out the existing branch directly (`git worktree add <wt>
    // <branch>`). Git refuses if the host already has it checked out — that
    // stderr is surfaced verbatim below. fork (default): create a fresh
    // branch with `-b` from `fromBranch ?? HEAD` (root only; nested → HEAD).
    const baseRef = r.repo.kind === 'root' ? (opts.fromBranch ?? 'HEAD') : 'HEAD';
    const addArgs = r.reuseBranch
      ? ['worktree', 'add', wt, r.branch]
      : ['worktree', 'add', '-b', r.branch, wt, baseRef];
    const add = await execa(
      'docker',
      ['exec', '--user', 'vscode', opts.container, 'git', '-C', main, ...addArgs],
      { reject: false },
    );
    if (add.exitCode !== 0) {
      throw new GitWorktreeError(
        `git worktree add ${wt} (branch ${r.branch}) failed: ${add.stderr || add.stdout}`,
      );
    }
    log(`worktree ${wt} on branch ${r.branch} (host main ${main})`);

    // Boxes don't carry the user's signing keys, so commit.gpgsign=true on
    // the host would make every in-box `git commit` fail. Enable per-worktree
    // config on the main repo, then disable signing on just this worktree.
    await execa(
      'docker',
      [
        'exec',
        '--user',
        'vscode',
        opts.container,
        'git',
        '-C',
        main,
        'config',
        'extensions.worktreeConfig',
        'true',
      ],
      { reject: false },
    );
    await execa(
      'docker',
      [
        'exec',
        '--user',
        'vscode',
        opts.container,
        'git',
        '-C',
        wt,
        'config',
        '--worktree',
        'commit.gpgsign',
        'false',
      ],
      { reject: false },
    );
  }

  // Phase 2: bind each worktree onto its agent-visible /workspace path.
  await bindWorktrees(
    opts.container,
    opts.repos.map((r) => ({
      kind: r.repo.kind,
      containerPath: r.containerPath,
      gitWorktreePath: r.gitWorktreePath,
    })),
    log,
  );

  // Phase 3: replay host carry-over into each worktree (via the
  // /workspace[*] symlinks, so the agent sees the changes at the canonical
  // paths it expects).
  for (const r of opts.repos) {
    const ct = r.containerPath;
    if (r.stashSha) {
      const withIndex = await execa(
        'docker',
        [
          'exec',
          '--user',
          'vscode',
          opts.container,
          'git',
          '-C',
          ct,
          'stash',
          'apply',
          '--index',
          r.stashSha,
        ],
        { reject: false },
      );
      if (withIndex.exitCode !== 0) {
        const noIndex = await execa(
          'docker',
          [
            'exec',
            '--user',
            'vscode',
            opts.container,
            'git',
            '-C',
            ct,
            'stash',
            'apply',
            r.stashSha,
          ],
          { reject: false },
        );
        if (noIndex.exitCode !== 0) {
          log(
            `warning: stash apply failed in ${ct} (${withIndex.stderr || withIndex.stdout || 'no message'})`,
          );
        } else {
          log(`applied tracked changes (without index — staged state lost) in ${ct}`);
        }
      } else {
        log(`applied tracked changes from host main into ${ct}`);
      }
    }
    if (r.untrackedNul.length > 0) {
      const tarOut = await execa('tar', ['-C', r.hostSource, '--null', '-T', '-', '-cf', '-'], {
        input: r.untrackedNul.replace(/\0$/, ''),
        encoding: 'buffer',
        reject: false,
      });
      if (tarOut.exitCode !== 0) {
        log(`warning: tar of untracked files for ${r.repo.hostMainRepo} failed: ${tarOut.stderr}`);
        continue;
      }
      const tarIn = await execa(
        'docker',
        ['exec', '-i', '--user', 'vscode', opts.container, 'tar', '-C', ct, '-xf', '-'],
        { input: tarOut.stdout as Buffer, reject: false },
      );
      if (tarIn.exitCode !== 0) {
        log(`warning: untracked-file copy into ${ct} failed: ${tarIn.stderr}`);
      } else {
        const count = r.untrackedNul.split('\0').filter((s) => s.length > 0).length;
        log(`copied ${String(count)} untracked file(s) into ${ct}`);
      }
    }
  }
}

/**
 * Tar-pipe a host source dir into the container's /workspace. Used for the
 * no-git case (no detected repos), and for the `--host-snapshot` flow where
 * the source is the APFS clone instead of the live workspace.
 *
 * Runs as uid:gid 1000:1000 so extracted files are owned by `vscode` (the
 * in-container user) — same convention as `copyHostEnvFilesToBox`.
 */
export async function seedWorkspaceFromDir(opts: {
  container: string;
  hostSource: string;
  onLog?: (line: string) => void;
}): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const tarOut = await execa('tar', ['-C', opts.hostSource, '-cf', '-', '.'], {
    encoding: 'buffer',
    reject: false,
  });
  if (tarOut.exitCode !== 0) {
    throw new GitWorktreeError(`tar of ${opts.hostSource} failed: ${tarOut.stderr}`);
  }
  const tarIn = await execa(
    'docker',
    ['exec', '-i', '--user', '1000:1000', opts.container, 'tar', '-C', '/workspace', '-xf', '-'],
    { input: tarOut.stdout as Buffer, reject: false },
  );
  if (tarIn.exitCode !== 0) {
    throw new GitWorktreeError(`tar extract into /workspace failed: ${tarIn.stderr}`);
  }
  log(`seeded /workspace from ${opts.hostSource}`);
}

/**
 * Remove an in-container worktree from the host's main repo's worktree
 * registry. Called from `destroyBox` per registered worktree. The registered
 * path (`gitWorktreePath`) was a container-only path (under `WORKTREE_ROOT`),
 * so `git worktree remove` will see it as missing and we go straight to
 * `worktree prune` to drop the registry entry. Best-effort throughout.
 */
export async function removeInBoxWorktree(args: {
  hostMainRepo: string;
  gitWorktreePath: string;
}): Promise<void> {
  const remove = await execa(
    'git',
    ['-C', args.hostMainRepo, 'worktree', 'remove', '--force', args.gitWorktreePath],
    { reject: false },
  );
  if (remove.exitCode === 0) return;
  await execa('git', ['-C', args.hostMainRepo, 'worktree', 'prune'], { reject: false });
}

function ctParent(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
