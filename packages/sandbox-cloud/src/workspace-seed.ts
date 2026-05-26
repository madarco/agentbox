import { execa } from 'execa';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { classifyRemoteUrl, detectGitRepos } from '@agentbox/sandbox-core';
import { bashScript, quoteShellArgv } from './shell.js';

/**
 * Seed `/workspace` inside a cloud sandbox from the host workspace.
 *
 * Two strategies, picked at runtime per repo:
 *
 *   - **Fast path** ("in-box clone"): when the backend exposes
 *     `execGitWithHostCreds` (Hetzner today) and the host repo has an SSH or
 *     HTTPS origin that is reachable from the box with the host's forwarded
 *     credentials, the box clones shallow from origin itself — saving the
 *     host's upstream bandwidth. The host then ships only a small delta
 *     bundle (refs/commits that aren't on origin) + stash + untracked.
 *   - **Bundle path** ("host-bundle clone", today's default): the host runs
 *     `git bundle create --depth=N HEAD` and uploads the whole bundle; the
 *     box clones from the file. Used for Daytona, for repos with no origin
 *     or unreachable origin, or when the host has no credentials configured.
 *
 *   - Non-git workspace: tar the host workspace, upload, extract (unchanged).
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
        ? `seeding /workspace from git (+${String(nested.length)} nested repo${nested.length === 1 ? '' : 's'})`
        : 'seeding /workspace from git',
    );
    await seedFromGitBundle({
      backend: args.backend,
      handle: args.handle,
      hostRepo: root.hostMainRepo,
      branch: args.branch,
      workspaceDir,
      onLog: log,
    });
    for (const r of nested) {
      const sub = `${workspaceDir}/${r.relPathFromWorkspace}`;
      log(`seeding nested repo ${r.relPathFromWorkspace}`);
      await seedFromGitBundle({
        backend: args.backend,
        handle: args.handle,
        hostRepo: r.hostMainRepo,
        branch: args.branch,
        workspaceDir: sub,
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

interface SeedFromGitBundleArgs {
  backend: CloudBackend;
  handle: CloudHandle;
  hostRepo: string;
  branch: string;
  workspaceDir: string;
  onLog?: (line: string) => void;
}

/**
 * Default shallow depth applied to both paths when `AGENTBOX_BUNDLE_DEPTH`
 * is unset. ~6 months of typical commit cadence — enough for agent
 * grounding (`git log`, recent `git blame`), small enough to avoid
 * monorepo blow-ups. Override with `AGENTBOX_BUNDLE_DEPTH=full` for
 * unlimited history, or a positive int for a specific depth.
 */
const DEFAULT_BUNDLE_DEPTH = 200;

/** Adaptive-reshallow target when default-depth bundle exceeds the budget. */
const RESHALLOW_FALLBACK_DEPTH = 100;

/** Bundle file size budget (MB) before adaptive reshallow kicks in. */
const DEFAULT_BUNDLE_BUDGET_MB = 100;

interface BundleDepth {
  /** 'full' = no `--depth=N`. 'shallow' = pass `--depth=<depth>`. */
  kind: 'full' | 'shallow';
  /** Shallow depth (undefined for 'full'). */
  depth?: number;
  /** True when the user set AGENTBOX_BUNDLE_DEPTH explicitly. Disables auto-reshallow. */
  explicit: boolean;
}

/**
 * Resolve the bundle depth from `AGENTBOX_BUNDLE_DEPTH`:
 *   - unset / empty / 'auto'  → default 200 (not explicit)
 *   - 'full' / '0' / negative → no depth limit
 *   - positive int            → that depth
 */
function resolveBundleDepth(): BundleDepth {
  const raw = process.env['AGENTBOX_BUNDLE_DEPTH'];
  if (!raw || raw === 'auto') return { kind: 'shallow', depth: DEFAULT_BUNDLE_DEPTH, explicit: false };
  if (raw.toLowerCase() === 'full') return { kind: 'full', explicit: true };
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return { kind: 'full', explicit: true };
  return { kind: 'shallow', depth: n, explicit: true };
}

function bundleBudgetBytes(): number {
  const raw = process.env['AGENTBOX_BUNDLE_BUDGET_MB'];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  const mb = Number.isFinite(n) && n > 0 ? n : DEFAULT_BUNDLE_BUDGET_MB;
  return mb * 1024 * 1024;
}

const STASH_CARRYOVER_REF = 'refs/agentbox-carryover/stash';
const REMOTE_UNTRACKED_TAR = '/tmp/agentbox-carryover-untracked.tar.gz';

interface CarryOver {
  stashSha: string | null;
  /** Set on the host repo once update-ref succeeded; caller deletes in finally. */
  stashRefOwned: boolean;
  untrackedSize: number;
  untrackedTarPath: string;
}

async function prepareCarryOver(hostRepo: string, stage: string): Promise<CarryOver> {
  const stashSha = await safeStashCreate(hostRepo);
  const untrackedTarPath = join(stage, 'untracked.tar.gz');
  const untrackedSize = await maybeBuildUntrackedTar(hostRepo, untrackedTarPath);
  let stashRefOwned = false;
  if (stashSha) {
    const ref = await execa(
      'git',
      ['-C', hostRepo, 'update-ref', STASH_CARRYOVER_REF, stashSha],
      { reject: false },
    );
    stashRefOwned = ref.exitCode === 0;
  }
  return { stashSha, stashRefOwned, untrackedSize, untrackedTarPath };
}

async function releaseCarryOver(hostRepo: string, carry: CarryOver): Promise<void> {
  if (carry.stashRefOwned) {
    await execa('git', ['-C', hostRepo, 'update-ref', '-d', STASH_CARRYOVER_REF], { reject: false });
  }
}

async function seedFromGitBundle(args: SeedFromGitBundleArgs): Promise<void> {
  const stage = await mkdtemp(join(tmpdir(), 'agentbox-bundle-'));
  const log = args.onLog ?? (() => {});
  const depth = resolveBundleDepth();
  const carry = await prepareCarryOver(args.hostRepo, stage);

  try {
    // Try the fast path first when the backend supports it and we have a
    // reachable origin with credentials. On any failure, fall through to the
    // bundle path which is guaranteed to work but trades the host's upstream
    // bandwidth.
    const force = (process.env['AGENTBOX_FORCE_BUNDLE_SEED'] ?? '').toLowerCase();
    const forceBundle = force === '1' || force === 'true' || force === 'yes';
    const fastTried = !forceBundle && (await tryFastClone({ args, stage, carry, depth, log }));
    if (fastTried) return;
    await runBundleClone({ args, stage, carry, depth, log });
  } finally {
    await releaseCarryOver(args.hostRepo, carry);
    await rm(stage, { recursive: true, force: true });
  }
}

interface PathDeps {
  args: SeedFromGitBundleArgs;
  stage: string;
  carry: CarryOver;
  depth: BundleDepth;
  log: (line: string) => void;
}

/**
 * Fast path: have the box clone shallow from origin (with the host's
 * credentials forwarded for that one exec), then ship only the small delta
 * of unpushed commits + stash + untracked.
 *
 * Returns `true` when the fast path completed (success). Returns `false`
 * when the preconditions don't apply or an early-stage probe failed — the
 * caller falls back to the bundle path. On a post-clone failure we still
 * return `false` (and clean up the partial workspace) so the bundle path
 * can recover.
 */
async function tryFastClone(deps: PathDeps): Promise<boolean> {
  const { args, stage, carry, depth, log } = deps;
  const execGit = args.backend.execGitWithHostCreds?.bind(args.backend);
  if (!execGit) return false;

  const remoteUrl = await readOriginUrl(args.hostRepo);
  if (!remoteUrl) {
    log('git fast seed: no host origin URL — falling back to bundle');
    return false;
  }
  const scheme = classifyRemoteUrl(remoteUrl);
  if (scheme === 'other') {
    log(`git fast seed: unsupported origin scheme (${remoteUrl}) — falling back to bundle`);
    return false;
  }
  if (scheme === 'ssh' && !process.env['SSH_AUTH_SOCK']) {
    log('git fast seed: SSH_AUTH_SOCK not set on host — falling back to bundle');
    return false;
  }

  // Reachability probe. Cheap: one `ls-remote --exit-code HEAD`. 15s ceiling
  // because credential resolution + DNS + handshake can take a few seconds.
  log(`git fast seed: probing ${remoteUrl} reachability from box…`);
  const probe = await execGit(args.handle, ['ls-remote', '--exit-code', remoteUrl, 'HEAD'], {
    remoteUrl,
    hostRepo: args.hostRepo,
    attemptTimeoutMs: 15_000,
  });
  if (probe.exitCode !== 0) {
    log(
      `git fast seed: reachability probe failed (exit ${String(probe.exitCode)}: ${truncate(probe.stderr || probe.stdout)}) — falling back to bundle`,
    );
    return false;
  }

  // Clone shallow into the workspace dir.
  const cloneArgs = [
    'clone',
    '--no-checkout',
    ...(depth.kind === 'shallow' && depth.depth ? [`--depth=${String(depth.depth)}`] : []),
    remoteUrl,
    args.workspaceDir,
  ];
  const SUDO = `if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi`;
  // Wipe + chown the destination dir before the clone (same rationale as the
  // bundle path: the snapshot's /workspace is root-owned). Run as a single
  // shell so we don't pay multiple ssh round-trips.
  const wipe = await args.backend.exec(
    args.handle,
    bashScript(
      [
        `set -euo pipefail`,
        `cd /tmp`,
        SUDO,
        `$SUDO rm -rf ${quoteShellArgv([args.workspaceDir])}`,
        `$SUDO mkdir -p ${quoteShellArgv([args.workspaceDir])}`,
        `$SUDO chown "$(id -un):$(id -gn)" ${quoteShellArgv([args.workspaceDir])}`,
      ].join('\n'),
    ),
  );
  if (wipe.exitCode !== 0) {
    log(`git fast seed: wipe-and-chown failed: ${truncate(wipe.stderr || wipe.stdout)} — falling back to bundle`);
    return false;
  }

  log(
    `git fast seed: in-box clone from origin (${scheme}${depth.kind === 'shallow' && depth.depth ? `, depth=${String(depth.depth)}` : ', full'})…`,
  );
  const clone = await execGit(args.handle, cloneArgs, {
    remoteUrl,
    hostRepo: args.hostRepo,
    attemptTimeoutMs: 10 * 60_000,
  });
  if (clone.exitCode !== 0) {
    log(`git fast seed: clone failed (exit ${String(clone.exitCode)}: ${truncate(clone.stderr || clone.stdout)}) — falling back to bundle`);
    // Best-effort wipe the partial clone before the bundle path runs.
    await args.backend
      .exec(args.handle, bashScript(`cd /tmp; if command -v sudo >/dev/null 2>&1; then sudo -n rm -rf ${quoteShellArgv([args.workspaceDir])}; else rm -rf ${quoteShellArgv([args.workspaceDir])}; fi`))
      .catch(() => {
        /* best-effort */
      });
    return false;
  }

  // Build the delta bundle on host: refs reachable from local branches/tags
  // that are NOT reachable from any origin/* remote-tracking ref, plus the
  // stash carryover ref. Typically tiny; often empty.
  const deltaBundlePath = join(stage, 'delta.bundle');
  let deltaBundleSize = 0;
  const deltaArgs: string[] = [
    '-C', args.hostRepo, 'bundle', 'create', deltaBundlePath,
    '--branches', '--tags', '--not', '--remotes=origin',
  ];
  if (carry.stashRefOwned) deltaArgs.push(STASH_CARRYOVER_REF);
  const delta = await execa('git', deltaArgs, { reject: false });
  if (delta.exitCode === 0) {
    try {
      deltaBundleSize = (await stat(deltaBundlePath)).size;
    } catch {
      deltaBundleSize = 0;
    }
  } else {
    // `git bundle create` fails with non-zero when there's nothing reachable
    // to bundle — that's expected when HEAD == origin/HEAD and there's no
    // stash. We treat it as "no delta to ship".
    deltaBundleSize = 0;
  }

  const REMOTE_DELTA_BUNDLE = '/tmp/agentbox-workspace-delta.bundle';
  if (deltaBundleSize > 0) {
    log(`git fast seed: shipping ${formatBytes(deltaBundleSize)} delta bundle…`);
    await args.backend.uploadFile(args.handle, deltaBundlePath, REMOTE_DELTA_BUNDLE);
  } else {
    log('git fast seed: no delta to ship (box matches origin)');
  }
  if (carry.untrackedSize > 0) {
    await args.backend.uploadFile(args.handle, carry.untrackedTarPath, REMOTE_UNTRACKED_TAR);
  }

  // In-box: fetch the delta (if any), check out the per-box branch, apply
  // stash, extract untracked. Mirrors the bundle path's tail.
  const carryOverSteps = buildCarryOverSteps(args.workspaceDir, carry);
  const fetchDeltaStep =
    deltaBundleSize > 0
      ? [
          `if [ -f ${quoteShellArgv([REMOTE_DELTA_BUNDLE])} ]; then ` +
            `git -C ${quoteShellArgv([args.workspaceDir])} fetch ${quoteShellArgv([REMOTE_DELTA_BUNDLE])} ` +
            `--tags '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*' || true ; ` +
            `rm -f ${quoteShellArgv([REMOTE_DELTA_BUNDLE])} ; ` +
            `fi`,
        ]
      : [];
  const finalScript = [
    `set -euo pipefail`,
    `cd /tmp`,
    ...fetchDeltaStep,
    `git -C ${quoteShellArgv([args.workspaceDir])} checkout -B ${quoteShellArgv([args.branch])}`,
    ...carryOverSteps,
  ].join('\n');
  const tail = await args.backend.exec(args.handle, bashScript(finalScript));
  if (tail.exitCode !== 0) {
    log(`git fast seed: post-clone steps failed: ${truncate(tail.stderr || tail.stdout)} — falling back to bundle`);
    // The clone succeeded but checkout/apply failed; wipe so the bundle
    // path can re-clone cleanly.
    await args.backend
      .exec(args.handle, bashScript(`cd /tmp; if command -v sudo >/dev/null 2>&1; then sudo -n rm -rf ${quoteShellArgv([args.workspaceDir])}; else rm -rf ${quoteShellArgv([args.workspaceDir])}; fi`))
      .catch(() => {
        /* best-effort */
      });
    return false;
  }
  log('git fast seed: done');
  return true;
}

/**
 * Bundle path: today's behavior. `git bundle create --depth=N HEAD` on host,
 * upload, in-box clone from the bundle, repoint origin.
 *
 * Adaptive size guard: if we're using the default depth and the produced
 * bundle exceeds `AGENTBOX_BUNDLE_BUDGET_MB`, rebuild with a smaller depth
 * (100). Honors user-explicit `AGENTBOX_BUNDLE_DEPTH` settings — no
 * auto-reshallow when the user picked a number.
 */
async function runBundleClone(deps: PathDeps): Promise<void> {
  const { args, stage, carry, depth, log } = deps;
  const bundlePath = join(stage, 'workspace.bundle');
  const usedDepth = await buildBundleWithSizeGuard(args.hostRepo, bundlePath, depth, carry, log);

  const remoteUrl = await readOriginUrl(args.hostRepo);
  const remoteBundle = '/tmp/agentbox-workspace.bundle';
  await args.backend.uploadFile(args.handle, bundlePath, remoteBundle);
  if (carry.untrackedSize > 0) {
    await args.backend.uploadFile(args.handle, carry.untrackedTarPath, REMOTE_UNTRACKED_TAR);
  }
  const setOrigin = remoteUrl
    ? `git -C ${quoteShellArgv([args.workspaceDir])} remote set-url origin ${quoteShellArgv([remoteUrl])}`
    : ': # no host origin to copy';
  const SUDO = `if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi`;
  const carryOverSteps = buildCarryOverSteps(args.workspaceDir, carry);
  const script = [
    `set -euo pipefail`,
    `cd /tmp`,
    SUDO,
    `$SUDO rm -rf ${quoteShellArgv([args.workspaceDir])}`,
    `$SUDO mkdir -p ${quoteShellArgv([args.workspaceDir])}`,
    `$SUDO chown "$(id -un):$(id -gn)" ${quoteShellArgv([args.workspaceDir])}`,
    `git clone ${quoteShellArgv([remoteBundle, args.workspaceDir])}`,
    setOrigin,
    `git -C ${quoteShellArgv([args.workspaceDir])} fetch ${quoteShellArgv([remoteBundle])} --tags '+refs/heads/*:refs/remotes/bundle/*' || true`,
    `git -C ${quoteShellArgv([args.workspaceDir])} checkout -B ${quoteShellArgv([args.branch])}`,
    ...carryOverSteps,
    `rm -f ${quoteShellArgv([remoteBundle])}`,
  ].join('\n');
  log(`git bundle seed: clone-from-bundle (${usedDepth.kind === 'shallow' && usedDepth.depth ? `depth=${String(usedDepth.depth)}` : 'full'})…`);
  const r = await args.backend.exec(args.handle, bashScript(script));
  if (r.exitCode !== 0) {
    throw new Error(`workspace seed (bundle) failed: ${r.stderr || r.stdout}`);
  }
}

async function buildBundleWithSizeGuard(
  hostRepo: string,
  bundlePath: string,
  depth: BundleDepth,
  carry: CarryOver,
  log: (line: string) => void,
): Promise<BundleDepth> {
  let effective = depth;
  await writeBundle(hostRepo, bundlePath, effective, carry, log);
  const size = await safeStat(bundlePath);
  const budget = bundleBudgetBytes();
  if (
    effective.kind === 'shallow' &&
    !effective.explicit &&
    size > budget &&
    (effective.depth ?? 0) > RESHALLOW_FALLBACK_DEPTH
  ) {
    log(
      `git bundle seed: bundle ${formatBytes(size)} > budget ${formatBytes(budget)}; reshallowing to depth=${String(RESHALLOW_FALLBACK_DEPTH)}`,
    );
    effective = { kind: 'shallow', depth: RESHALLOW_FALLBACK_DEPTH, explicit: false };
    await writeBundle(hostRepo, bundlePath, effective, carry, log);
    const size2 = await safeStat(bundlePath);
    if (size2 > budget) {
      log(`git bundle seed: bundle ${formatBytes(size2)} still over budget; uploading anyway`);
    }
  } else if (size > budget) {
    // Either user explicitly chose this depth, or we're already at the
    // fallback. Honor it but warn.
    log(`git bundle seed: bundle ${formatBytes(size)} > budget ${formatBytes(budget)}; uploading anyway`);
  }
  return effective;
}

let bundleDepthSupportProbed = false;
let bundleDepthSupported = true;

/**
 * One-shot probe for `git bundle create --depth=N` support. The flag was
 * added in git 2.40 (April 2023); older gits — notably the macOS system git
 * (2.39.x) — reject it with "unrecognized argument: --depth=". Cached for
 * the process lifetime so repeated bundle creations don't re-probe.
 *
 * We probe with `git bundle create --depth=1 /dev/null HEAD` (NUL-discarded
 * output) so the command both validates the flag AND fails fast.
 */
async function probeBundleDepthSupport(hostRepo: string): Promise<boolean> {
  if (bundleDepthSupportProbed) return bundleDepthSupported;
  const r = await execa('git', ['-C', hostRepo, 'bundle', 'create', '/dev/null', '--depth=1', 'HEAD'], { reject: false });
  // exit 128 with "unrecognized argument: --depth=1" → unsupported.
  // exit 0 (or some other non-flag error) → supported.
  const stderr = (r.stderr ?? '').toLowerCase();
  bundleDepthSupported = !stderr.includes('unrecognized argument: --depth');
  bundleDepthSupportProbed = true;
  return bundleDepthSupported;
}

async function writeBundle(
  hostRepo: string,
  bundlePath: string,
  depth: BundleDepth,
  carry: CarryOver,
  log: (line: string) => void,
): Promise<void> {
  const supportsDepth = depth.kind === 'shallow' && depth.depth ? await probeBundleDepthSupport(hostRepo) : true;
  const argv: string[] = ['-C', hostRepo, 'bundle', 'create', bundlePath];
  if (depth.kind === 'shallow' && depth.depth && supportsDepth) {
    argv.push(`--depth=${String(depth.depth)}`, 'HEAD');
  } else {
    if (depth.kind === 'shallow' && depth.depth && !supportsDepth) {
      log(
        `git bundle seed: host git too old for --depth=N (needs git 2.40+); bundling --all instead. Upgrade git or set AGENTBOX_BUNDLE_DEPTH=full to silence.`,
      );
    }
    argv.push('--all');
  }
  if (carry.stashRefOwned) argv.push(STASH_CARRYOVER_REF);
  await execa('git', argv);
}

function buildCarryOverSteps(workspaceDir: string, carry: CarryOver): string[] {
  const steps: string[] = [];
  if (carry.stashSha) {
    // The stash apply step is best-effort — applying onto a possibly
    // shallow clone can hit "needs merge" in pathological cases (host had
    // local changes against a commit outside the depth window). Soft-fail
    // rather than blocking provision.
    steps.push(
      `if git -C ${quoteShellArgv([workspaceDir])} rev-parse --verify ${quoteShellArgv([`refs/agentbox-carryover/stash`])} >/dev/null 2>&1; then ` +
        `git -C ${quoteShellArgv([workspaceDir])} stash apply ${quoteShellArgv([`refs/agentbox-carryover/stash`])} || ` +
        `echo "agentbox: stash apply soft-failed; carry-over may be incomplete" >&2 ; ` +
        `git -C ${quoteShellArgv([workspaceDir])} update-ref -d ${quoteShellArgv([`refs/agentbox-carryover/stash`])} || true ; ` +
        `elif git -C ${quoteShellArgv([workspaceDir])} rev-parse --verify ${quoteShellArgv([`refs/remotes/origin/agentbox-carryover/stash`])} >/dev/null 2>&1; then ` +
        // Legacy location: the bundle path used to fetch the stash ref under
        // refs/remotes/origin/agentbox-carryover/stash. Keep both for compat
        // until all in-flight bundles drain.
        `git -C ${quoteShellArgv([workspaceDir])} stash apply ${quoteShellArgv([`refs/remotes/origin/agentbox-carryover/stash`])} || ` +
        `echo "agentbox: stash apply soft-failed; carry-over may be incomplete" >&2 ; ` +
        `git -C ${quoteShellArgv([workspaceDir])} update-ref -d ${quoteShellArgv([`refs/remotes/origin/agentbox-carryover/stash`])} || true ; ` +
        `fi`,
    );
  }
  if (carry.untrackedSize > 0) {
    steps.push(
      `if [ -f ${quoteShellArgv([REMOTE_UNTRACKED_TAR])} ]; then ` +
        `tar -C ${quoteShellArgv([workspaceDir])} -xzf ${quoteShellArgv([REMOTE_UNTRACKED_TAR])} && ` +
        `rm -f ${quoteShellArgv([REMOTE_UNTRACKED_TAR])} ; ` +
        `fi`,
    );
  }
  return steps;
}

async function safeStat(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function truncate(s: string, max = 200): string {
  const t = (s ?? '').trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : t.slice(0, max) + '…';
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
    return (await stat(outPath)).size;
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
