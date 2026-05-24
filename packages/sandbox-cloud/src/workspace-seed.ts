import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
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
 *   - Git workspace: `git bundle create --all` on the host, upload the bundle,
 *     `git clone` it inside the sandbox, repoint `origin`, check out the
 *     per-box branch `agentbox/<box-name>`. Repeats for every nested repo
 *     (1st-level subdir with its own `.git/`) so monorepos seed correctly.
 *   - Non-git workspace: tar the host workspace, upload, extract.
 *
 * Host-uncommitted-carry-over (stash + untracked) is the remaining gap
 * tracked in Phase 6.
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
  onLog?: (line: string) => void;
}

export interface SeedCloudWorkspaceResult {
  /** True when a git repo was found at the workspace root and a bundle was used. */
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
        ? `seeding /workspace from git bundle (+${String(nested.length)} nested repo${nested.length === 1 ? '' : 's'})`
        : 'seeding /workspace from git bundle',
    );
    await seedFromGitBundle({
      backend: args.backend,
      handle: args.handle,
      hostRepo: root.hostMainRepo,
      branch: args.branch,
      workspaceDir,
    });
    // Each nested repo gets its own bundle + clone at /workspace/<rel>. We
    // do these after the root clone because the root clone wipes
    // /workspace; a nested dir created during the root checkout (if
    // tracked) would be replaced when we clone over it.
    for (const r of nested) {
      const sub = `${workspaceDir}/${r.relPathFromWorkspace}`;
      log(`seeding nested repo ${r.relPathFromWorkspace} from git bundle`);
      await seedFromGitBundle({
        backend: args.backend,
        handle: args.handle,
        hostRepo: r.hostMainRepo,
        branch: args.branch,
        workspaceDir: sub,
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

interface SeedFromGitBundleArgs {
  backend: CloudBackend;
  handle: CloudHandle;
  hostRepo: string;
  branch: string;
  workspaceDir: string;
}

async function seedFromGitBundle(args: SeedFromGitBundleArgs): Promise<void> {
  const stage = await mkdtemp(join(tmpdir(), 'agentbox-bundle-'));
  const bundlePath = join(stage, 'workspace.bundle');
  try {
    // Default: `--all` captures every ref + full history so the sandbox gets
    // a real clone with the user's local commits and tags. Monorepos with
    // deep history make that a slow + big upload — opt out via
    // `AGENTBOX_BUNDLE_DEPTH=N` to ship only the last N commits of HEAD
    // (shallow clone semantics; `git push` from inside the box still works
    // because the remote knows the merge base). 0 / empty / non-numeric →
    // full history.
    const depthRaw = process.env['AGENTBOX_BUNDLE_DEPTH'];
    const depth = depthRaw ? Number.parseInt(depthRaw, 10) : NaN;
    const bundleArgs: string[] = ['-C', args.hostRepo, 'bundle', 'create', bundlePath];
    if (Number.isFinite(depth) && depth > 0) {
      bundleArgs.push(`--depth=${String(depth)}`, 'HEAD');
    } else {
      bundleArgs.push('--all');
    }
    await execa('git', bundleArgs);
    const remoteUrl = await readOriginUrl(args.hostRepo);
    const remoteBundle = '/tmp/agentbox-workspace.bundle';
    await args.backend.uploadFile(args.handle, bundlePath, remoteBundle);
    const setOrigin = remoteUrl
      ? `git -C ${quoteShellArgv([args.workspaceDir])} remote set-url origin ${quoteShellArgv([remoteUrl])}`
      : ': # no host origin to copy';
    // Clone from the bundle (the bundle stands in for a remote), then repoint
    // `origin` to the real upstream so future fetch/push target the actual
    // remote — `git push` itself will travel back through the host relay in a
    // later phase. Finally check out the per-box branch from current HEAD.
    // /workspace lives at the root in the snapshot — root-owned by default
    // (Dockerfile.box never chowns it). The sandbox runs non-root, so the
    // dir ops need sudo. The devcontainers/base image grants passwordless
    // sudo to `vscode`; SUDO is a no-op when sudo isn't needed/available.
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
      // rm -rf only the directory we're about to clone into — for nested
      // repos this is just `/workspace/<rel>`, so the root clone (already
      // at `/workspace`) is preserved.
      `$SUDO rm -rf ${quoteShellArgv([args.workspaceDir])}`,
      `$SUDO mkdir -p ${quoteShellArgv([args.workspaceDir])}`,
      `$SUDO chown "$(id -un):$(id -gn)" ${quoteShellArgv([args.workspaceDir])}`,
      `git clone ${quoteShellArgv([remoteBundle, args.workspaceDir])}`,
      setOrigin,
      `git -C ${quoteShellArgv([args.workspaceDir])} fetch ${quoteShellArgv([remoteBundle])} --tags '+refs/heads/*:refs/remotes/bundle/*' || true`,
      `git -C ${quoteShellArgv([args.workspaceDir])} checkout -B ${quoteShellArgv([args.branch])}`,
      `rm -f ${quoteShellArgv([remoteBundle])}`,
    ].join('\n');
    // Daytona's executeCommand shells out via dash (`/bin/sh`), which rejects
    // bash idioms like `set -o pipefail`. Wrap in `bash -c` so the script
    // runs in bash regardless of what `/bin/sh` points at.
    const r = await args.backend.exec(args.handle, bashScript(script));
    if (r.exitCode !== 0) {
      throw new Error(`workspace seed (bundle) failed: ${r.stderr || r.stdout}`);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
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
