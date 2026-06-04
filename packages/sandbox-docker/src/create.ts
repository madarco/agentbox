import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execa } from 'execa';
import { ConfigError, loadConfig } from '@agentbox/ctl';
import {
  buildClaudeMounts,
  ensureClaudeVolume,
  resolveClaudeVolume,
  seedSetupSkillIntoVolume,
} from './claude.js';
import { syncClaudeCredentials } from './claude-credentials.js';
import {
  buildCodexMounts,
  ensureCodexVolume,
  resolveCodexVolume,
  seedCodexHooks,
  type CodexMountResult,
} from './codex.js';
import {
  buildOpencodeMounts,
  ensureOpencodeVolume,
  seedOpencodePlugin,
  resolveOpencodeVolume,
  type OpencodeMountResult,
} from './opencode.js';
import {
  type BoxLimitSpec,
  containerExists,
  dockerInfo,
  dockerStorageDriver,
  ensureVolume,
  publishedHostPort,
  runBox,
} from './docker.js';
import { dockerVolumeName, launchDockerdDaemon } from './dockerd.js';
import { generateVncPassword, launchVncDaemon, VNC_CONTAINER_PORT } from './vnc.js';
import { WEB_CONTAINER_PORT } from './web.js';
import { detectGitRepos, pickFreshBranch } from './git-worktree.js';
import {
  bindWorktrees,
  chownGitBindParents,
  collectRepoCarryOver,
  gitWorktreePathFor,
  regenerateRestoredWorktrees,
  removeInBoxWorktree,
  resyncWorkspaceFromHost,
  seedWorkspace,
  seedWorkspaceFromDir,
  type RepoCarryOver,
  type RestoreWorktreePlan,
} from './in-box-git.js';
import {
  CONTAINER_EXPORT_MERGED,
  DEFAULT_ENV_PATTERNS,
  boxRunDirFor,
  copyCarryPathsToBox,
  copyHostEnvFilesToBox,
  copyHostFilesToBox,
  detectEngine,
} from './host-export.js';
import {
  detectPortless,
  portlessAlias,
  portlessBrowserEnv,
  portlessGetUrl,
  portlessStartHint,
  resolvePortlessHostStateDir,
} from './portless.js';
import { DEFAULT_BOX_IMAGE, ensureImage } from './image.js';
import {
  readState,
  recordBox,
  removeBoxRecord,
  reserveProjectIndex,
  type BoxRecord,
  type GitWorktreeRecord,
} from './state.js';
import { generateBoxId, type ResolvedCarryEntry, type ResyncResult } from '@agentbox/core';
import { createSnapshot, snapshotPathFor } from './snapshot.js';
import { resolveCheckpoint } from './checkpoint.js';
import {
  computeDockerContextFingerprint,
  readPreparedDockerState,
} from './prepared-state.js';
import { launchCtlDaemon } from './ctl.js';
import { writeBoxEnvFile } from './box-env.js';
import { ensureHomeOwnedByVscode } from './home-ownership.js';
import {
  ensureRelay,
  generateRelayToken,
  registerBoxWithRelay,
  rehydrateRelayRegistry,
} from './relay.js';
import {
  buildIdeMounts,
  cursorServerVolumeName,
  ensureIdeVolumes,
  repairIdeOwnership,
  vscodeServerVolumeName,
} from './vscode.js';

export interface CreateBoxOptions {
  workspacePath: string;
  name?: string;
  /**
   * Take a `cp -c` APFS clone of the host workspace into
   * `~/.agentbox/snapshots/<id>/` before seeding `/workspace`. Stabilizes the
   * source of the tar pipe in the non-git case (and the untracked-file
   * pipe in the git case) against host edits during create. Effectively a
   * no-op when a git worktree is detected — the worktree's tracked content
   * comes from `.git`, not from a workspace copy.
   */
  useSnapshot: boolean;
  /**
   * Start the box from a project checkpoint (the `--snapshot <ref>` path).
   * Resolved against `projectRoot` (or `workspacePath` when unset). The
   * checkpoint is a local Docker *image* tag now; the box is created with
   * `docker run <ckpt-image>` and inherits a populated `/workspace`. No
   * `seedWorkspace` runs in this path.
   */
  checkpointRef?: string;
  /**
   * Base ref the box's per-box branch is forked from (default: HEAD). Caller
   * is responsible for validation + any required fetch beforehand. Accepts
   * any ref `git rev-parse` resolves; passed verbatim to `git worktree add`.
   */
  fromBranch?: string;
  /**
   * Reuse an existing branch (root repo only) instead of forking a fresh
   * `agentbox/<name>`. The root worktree is created with `git worktree add
   * <wt> <branch>` (no `-b`), so git fails fast if the host already has
   * `<useBranch>` checked out. No host stash / untracked carry-over is
   * replayed — the box gets the branch's committed tip. Nested repos keep
   * their per-box `agentbox/<name>--<sub>` branches. Mutually exclusive with
   * `fromBranch` (enforced by the CLI).
   */
  useBranch?: string;
  /**
   * When starting from a checkpoint, merge the host's current branch into the
   * restored worktree and overlay the host's uncommitted/untracked changes
   * (box wins on conflict). Defaults to true. No effect on a non-checkpoint
   * fresh create (which already forks from HEAD + carry-over).
   */
  resyncOnStart?: boolean;
  image?: string;
  /** Try the registry before building the base image. Defaults to true. */
  allowPull?: boolean;
  /** Registry repo for the base-image pull. Defaults to `BOX_IMAGE_REGISTRY`; empty disables. */
  imageRegistry?: string;
  onLog?: (line: string) => void;
  /**
   * Claude Code config volume. When omitted, defaults to `{ isolate: false }` —
   * every box mounts the shared `agentbox-claude-config` volume at
   * /home/vscode/.claude so auth / skills / plugins persist across boxes.
   */
  claudeConfig?: { isolate: boolean };
  /** Extra env vars forwarded to the container (merged on top of claude env forwarding). */
  claudeEnv?: Record<string, string>;
  /**
   * Codex CLI config volume. When provided (i.e. `agentbox codex`), the box
   * always mounts a synced `agentbox-codex-config` volume at /home/vscode/.codex.
   * When omitted, `createBox` still mounts it *if the host has a `~/.codex`*
   * (so a plain `agentbox create` for a Codex user gets a working box) — see
   * the codex block below. `isolate: true` opts into a per-box volume.
   */
  codexConfig?: { isolate: boolean };
  /**
   * OpenCode CLI config volume. When provided (i.e. `agentbox opencode`), the
   * box always mounts a synced `agentbox-opencode-config` volume. When omitted,
   * `createBox` still mounts it *if the host uses OpenCode* (`~/.config/opencode`
   * or `~/.local/share/opencode` exists). `isolate: true` opts into a per-box
   * volume. See the opencode block below.
   */
  opencodeConfig?: { isolate: boolean };
  /**
   * When true, run `npm install -g @playwright/cli@latest` inside the box after
   * `/workspace` is seeded. agent-browser is always installed in the image;
   * this flag adds the Playwright CLI on top for boxes that need it.
   */
  withPlaywright?: boolean;
  /**
   * When true, copy the host's env/config files (DEFAULT_ENV_PATTERNS basename
   * globs — `.env*`, `secrets.toml`, `agentbox.yaml`, ...) into the box's
   * /workspace after seeding, bypassing gitignore. The reverse of `pull env`.
   * One-shot at create time; the files persist in the container's writable
   * layer across pause/stop/start.
   */
  withEnv?: boolean;
  /**
   * Explicit relative-path file list to copy from `workspacePath` into the
   * box's /workspace after seeding (no glob expansion, no scan — the list is
   * pre-vetted, e.g. picked by the wizard's multiselect). Independent of
   * `withEnv`: if both are set, both run (idempotent on overlapping files).
   * One-shot at create time; persists across pause/stop/start.
   */
  envFilesToImport?: string[];
  /**
   * Pre-approved host→box file copies from `agentbox.yaml`'s `carry:` block.
   * Resolved + user-approved by the apps/cli layer (resolveCarry + the carry
   * prompt) before being threaded in here. Each entry is copied to its
   * declared `absDest` (NOT under /workspace) after env-file imports and
   * before the supervisor starts, so the first declared task can already
   * read e.g. `~/.agentbox/secrets.env`. Empty / undefined → no-op.
   */
  carry?: ResolvedCarryEntry[];
  /**
   * VNC stack (Xvnc on :1 + websockify serving noVNC on container :6080).
   * Defaults to enabled. The CLI exposes `--no-vnc` for opt-out. Disabling
   * skips port mapping + password generation + the in-container supervisor
   * launch; the apt-installed binaries stay in the image but are unused.
   */
  vnc?: { enabled: boolean };
  /**
   * Docker-in-Docker. Always-on (the in-box dockerd is part of the box
   * surface). When `sharedCache` is true the per-box `agentbox-docker-<id>`
   * volume is replaced with the shared `agentbox-docker-cache` volume — image
   * layers persist across boxes (and `destroy`/`prune` won't remove it).
   */
  docker?: { sharedCache: boolean };
  /**
   * When true, register a Portless route (`portless alias <box-name> <webPort>`)
   * so the box web app is reachable at `https://<box-name>.localhost`. Only
   * acts on non-OrbStack engines (OrbStack already has `.orb.local`) and only
   * when Portless is installed on the host — best-effort, never fails create.
   */
  portless?: boolean;
  /**
   * Override for the host Portless state directory shared into the box (the
   * `portless.stateDir` config key). When unset, `createBox` resolves Portless's
   * own default. Only consulted when `portless` is true.
   */
  portlessStateDir?: string;
  /**
   * Absolute host path of the cwd's project at create time. When provided,
   * `createBox` stamps `projectRoot` + an allocated `projectIndex` on the
   * BoxRecord so the CLI can auto-pick / resolve by index. The CLI computes
   * this via `findProjectRoot(workspacePath)` from `@agentbox/config`; this
   * package stays free of the config dep. Omit for unowned boxes created
   * directly via the programmatic API.
   */
  projectRoot?: string;
  /**
   * Container resource ceilings (engine-agnostic: bytes / fractional cpus /
   * pid count / raw disk size string). Absent fields = unlimited. `disk` is
   * best-effort: dropped (with a warning via `onLog`) when the engine's
   * storage driver can't enforce `--storage-opt size=` (overlay2 / macOS).
   */
  limits?: BoxLimitSpec;
}

export interface CreatedBox {
  record: BoxRecord;
  imageBuilt: boolean;
  /** Conflicts from the on-create resync (checkpoint-restore path). Absent when no resync ran. */
  resync?: ResyncResult;
}

/**
 * Compact the engine-applied limits into the BoxRecord shape: only fields that
 * actually constrain the box (>0 / non-empty). Returns undefined when nothing
 * was applied so legacy/unlimited boxes stay free of the field.
 */
function persistableLimits(
  lim: BoxLimitSpec | undefined,
): BoxRecord['resourceLimits'] | undefined {
  if (!lim) return undefined;
  const out: NonNullable<BoxRecord['resourceLimits']> = {};
  if (lim.memoryBytes && lim.memoryBytes > 0) out.memoryBytes = Math.floor(lim.memoryBytes);
  if (lim.cpus && lim.cpus > 0) out.cpus = lim.cpus;
  if (lim.pidsLimit && lim.pidsLimit > 0) out.pidsLimit = Math.floor(lim.pidsLimit);
  if (lim.disk) out.disk = lim.disk;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function sanitizeBasename(workspacePath: string): string {
  const raw = basename(resolve(workspacePath));
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 30)
    .replace(/[-._]+$/, '');
}

export function defaultBoxName(workspacePath: string, id: string): string {
  const base = sanitizeBasename(workspacePath);
  return base.length > 0 ? `${base}-${id}` : id;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ~/.claude and ~/.codex are intentionally NOT in this list: each lives in a
// named volume (`agentbox-claude-config` / `agentbox-codex-config`, see
// resolveClaudeVolume / resolveCodexVolume) so auth persists inside the
// container without leaking host state. Only the remaining identity files are
// bind-mounted from the host.
async function buildIdentityMounts(): Promise<string[]> {
  const home = homedir();
  const candidates: Array<{ src: string; dst: string; readOnly: boolean }> = [
    { src: join(home, '.gitconfig'), dst: '/home/vscode/.gitconfig', readOnly: true },
  ];
  const out: string[] = [];
  for (const c of candidates) {
    if (await pathExists(c.src)) {
      out.push(`${c.src}:${c.dst}${c.readOnly ? ':ro' : ''}`);
    }
  }
  return out;
}

export async function createBox(opts: CreateBoxOptions): Promise<CreatedBox> {
  const log = opts.onLog ?? (() => {});
  const workspace = resolve(opts.workspacePath);
  if (!(await pathExists(workspace))) {
    throw new Error(`workspace does not exist: ${workspace}`);
  }

  // Pre-flight agentbox.yaml validation on the host so the user sees the real
  // ConfigError instead of an opaque "socket did not appear" timeout from the
  // detached daemon exec later. The daemon re-validates inside the box anyway
  // — defence in depth, and necessary because the file lives in the
  // container's writable layer and can be edited after create.
  const cfgPath = join(workspace, 'agentbox.yaml');
  if (await pathExists(cfgPath)) {
    try {
      const cfg = await loadConfig(cfgPath);
      log(`agentbox.yaml validated (${String(cfg.services.length)} service(s))`);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new Error(`agentbox.yaml validation failed:\n  ${err.message}`);
      }
      throw err;
    }
  }

  await dockerInfo();
  log('docker daemon reachable');

  // Checkpoint resolution happens *before* image ensure because a checkpoint
  // image replaces the base image as the docker-run base. resolveCheckpoint
  // returns null on miss; we error with the ref so the user can fix it.
  let checkpointImage: string | undefined;
  let checkpointSource: BoxRecord['checkpointSource'];
  let restoredWorktrees: GitWorktreeRecord[] | undefined;
  let resyncResult: ResyncResult | undefined;
  if (opts.checkpointRef) {
    const projectRootForCkpt = opts.projectRoot ?? workspace;
    const head = await resolveCheckpoint(projectRootForCkpt, opts.checkpointRef);
    if (!head) {
      throw new Error(`checkpoint not found: ${opts.checkpointRef}`);
    }
    checkpointImage = head.manifest.image;
    // Chain: head first then its parents (base-most last). For a flattened
    // checkpoint this collapses to a single-entry chain.
    const chain = [head.name, ...head.manifest.parents];
    checkpointSource = { ref: opts.checkpointRef, type: head.manifest.type, chain };
    // The source's per-worktree paths persisted on the manifest so we can
    // re-establish the /workspace bind mount(s) after `docker run` (docker
    // commit doesn't capture bind-mount content, so the image's /workspace
    // is empty until we re-bind).
    restoredWorktrees = head.manifest.worktrees;
    log(
      `starting from checkpoint ${opts.checkpointRef} (${head.manifest.type}, ${String(chain.length)} layer(s), image ${head.manifest.image})`,
    );

    // Stale-checkpoint warning: the checkpoint image replaces the base image
    // as the docker-run base, so any base-image update (a CLI upgrade, an
    // edit to `custom-system-CLAUDE.md`, etc.) is invisible inside a box
    // restored from a pre-update checkpoint. Compare the captured
    // fingerprint with the current prepared state and surface the
    // mismatch loudly. We never block — the user might intentionally pin
    // an old image — but they need to know.
    const ckptFingerprint = head.manifest.baseFingerprint;
    const ckptCliVersion = head.manifest.cliVersion ?? 'unknown';
    if (head.manifest.schema === 2) {
      log(
        `WARNING: checkpoint '${opts.checkpointRef}' was captured before checkpoint versioning landed.\n` +
          `  Its base-image layers may be older than your current base image. If the box is missing\n` +
          `  expected updates, remove the checkpoint with \`agentbox checkpoint rm ${opts.checkpointRef}\` and recreate it.`,
      );
    } else {
      const prepared = readPreparedDockerState();
      const currentFingerprint =
        prepared?.base?.contextSha256 ??
        (await computeDockerContextFingerprint())?.contextSha256;
      if (
        ckptFingerprint &&
        currentFingerprint &&
        ckptFingerprint !== currentFingerprint
      ) {
        log(
          `WARNING: checkpoint '${opts.checkpointRef}' was captured against an older base image.\n` +
            `  captured: cli ${ckptCliVersion}, fingerprint ${ckptFingerprint.slice(0, 12)}\n` +
            `  current : cli ${prepared?.base?.cliVersion ?? 'unknown'}, fingerprint ${currentFingerprint.slice(0, 12)}\n` +
            `  The restored box will keep the old base layers and will NOT include base-image updates.\n` +
            `  To pick up updates: \`agentbox checkpoint rm ${opts.checkpointRef}\` and recreate from a fresh box.`,
        );
      }
    }
  }

  const imageRef = checkpointImage ?? opts.image ?? DEFAULT_BOX_IMAGE;
  // ensureImage only acts on the base image; checkpoint images are local-only
  // and must already exist (they were created by `agentbox checkpoint`).
  const ensureRef = checkpointImage ? (opts.image ?? DEFAULT_BOX_IMAGE) : imageRef;
  const { built } = await ensureImage(ensureRef, {
    onProgress: (line) => log(`[image] ${line}`),
    allowPull: opts.allowPull,
    registry: opts.imageRegistry,
  });
  log(built ? `built image ${ensureRef}` : `using cached image ${imageRef}`);

  // Bring up the host relay before the box so the box can post events
  // immediately on boot. Best-effort — a relay outage shouldn't block create.
  // Always re-push known box tokens after ensure: the relay's registry is
  // in-memory, so a daemon restart or `docker restart agentbox-relay` between
  // CLI invocations leaves it empty. Repushing is idempotent and cheap.
  let relayUp = false;
  try {
    await ensureRelay({ onLog: log });
    const existing = await readState();
    await rehydrateRelayRegistry(existing.boxes);
    relayUp = true;
  } catch (err) {
    log(`relay unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const id = generateBoxId();
  const name = opts.name ?? defaultBoxName(workspace, id);
  const containerName = `agentbox-${name}`;
  const createdAt = new Date().toISOString();
  if (await containerExists(containerName)) {
    throw new Error(`container ${containerName} already exists; remove it first`);
  }

  // Per-project monotonic index. Reserved *atomically* here (under the state
  // lock, persisting a minimal record that claims it) so it can flow into the
  // box / snapshot dir segments (`<id>-<n>-<mnemonic>`) and the
  // `AGENTBOX_PROJECT_INDEX` env var with no risk of a concurrent create
  // claiming the same number and forcing a later bump that would desync the
  // recorded index from the dir already created from it. The full record is
  // written over this reservation by the provisional + final recordBox below.
  // Pre-feature legacy boxes never pass `projectRoot`; those keep `projectIndex`
  // undefined and the dir segments fall back to `<id>-<mnemonic>`.
  let projectIndex: number | undefined;
  if (opts.projectRoot) {
    projectIndex = await reserveProjectIndex(
      { id, name, container: containerName, image: imageRef, workspacePath: workspace, createdAt },
      opts.projectRoot,
    );
  }

  // Repo detection + host-side carry-over capture. Branches are picked here
  // (against the host main repos' refs) so they're recorded on the BoxRecord
  // regardless of whether the in-container `git worktree add` succeeds later.
  // When restoring from a checkpoint, the source's per-worktree records are
  // restored from the manifest *here* (not after `docker run`) so the
  // `.git/` bind-mounts in `extraVolumes` know which host main repos to
  // wire up — without those binds the in-container `/workspace/.git` would
  // resolve to a path that doesn't exist in the new container.
  const repoCarryOvers: RepoCarryOver[] = [];
  const gitWorktreeRecords: GitWorktreeRecord[] = [];
  // Checkpoint restore: the manifest's worktree records carry the *source*
  // box's branch + path. Reusing them verbatim is the shared-worktree bug —
  // every box from one checkpoint would share a single branch + index, and the
  // baked /workspace/.git gitfile dangles once the source box's host worktree
  // metadata was pruned. So mint a FRESH per-box branch + unique worktree path
  // here (host-side, before docker run, like the non-checkpoint path) and
  // regenerate the in-box worktree over the baked content after run.
  const restoreWorktreePlans: RestoreWorktreePlan[] = [];
  if (checkpointImage && restoredWorktrees && restoredWorktrees.length > 0) {
    for (const w of restoredWorktrees) {
      const branchBase =
        w.kind === 'root'
          ? `agentbox/${name}`
          : `agentbox/${name}--${w.relPathFromWorkspace.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
      const freshBranch = await pickFreshBranch(w.hostMainRepo, branchBase);
      const freshGitWorktreePath = gitWorktreePathFor(freshBranch);
      restoreWorktreePlans.push({
        hostMainRepo: w.hostMainRepo,
        kind: w.kind,
        bakedGitWorktreePath: w.gitWorktreePath,
        freshBranch,
        freshGitWorktreePath,
      });
      gitWorktreeRecords.push({
        kind: w.kind,
        hostMainRepo: w.hostMainRepo,
        containerPath: w.containerPath,
        gitWorktreePath: freshGitWorktreePath,
        branch: freshBranch,
        relPathFromWorkspace: w.relPathFromWorkspace,
      });
    }
  }
  if (!checkpointImage) {
    const repos = await detectGitRepos(workspace);
    if (repos.length > 0) {
      log(
        `detected ${String(repos.length)} git repo(s): ` +
          repos.map((r) => `${r.kind}${r.relPathFromWorkspace ? '@' + r.relPathFromWorkspace : ''}`).join(', '),
      );
    }
    for (const r of repos) {
      const containerPath =
        r.kind === 'root' ? '/workspace' : `/workspace/${r.relPathFromWorkspace}`;
      // --use-branch reuses the named branch for the *root* repo only: no
      // pickFreshBranch (we want the exact branch), no carry-over replay (the
      // user wants the branch's committed tip, not host uncommitted state).
      // Nested repos always fork their own per-box branch — the root's reused
      // branch won't exist in a nested repo.
      const reuseBranch = r.kind === 'root' && opts.useBranch !== undefined;
      if (reuseBranch) {
        const branch = opts.useBranch as string;
        const gitWorktreePath = gitWorktreePathFor(branch);
        repoCarryOvers.push({
          repo: r,
          containerPath,
          gitWorktreePath,
          branch,
          stashSha: null,
          untrackedNul: '',
          hostSource: r.hostMainRepo,
          reuseBranch: true,
        });
        gitWorktreeRecords.push({
          kind: r.kind,
          hostMainRepo: r.hostMainRepo,
          containerPath,
          gitWorktreePath,
          branch,
          relPathFromWorkspace: r.relPathFromWorkspace,
        });
        continue;
      }
      const branchBase =
        r.kind === 'root'
          ? `agentbox/${name}`
          : `agentbox/${name}--${r.relPathFromWorkspace.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
      const branch = await pickFreshBranch(r.hostMainRepo, branchBase);
      const gitWorktreePath = gitWorktreePathFor(branch);
      const carry = await collectRepoCarryOver(r, branch, containerPath, gitWorktreePath);
      repoCarryOvers.push(carry);
      gitWorktreeRecords.push({
        kind: r.kind,
        hostMainRepo: r.hostMainRepo,
        containerPath,
        gitWorktreePath,
        branch,
        relPathFromWorkspace: r.relPathFromWorkspace,
      });
    }
  }

  // --host-snapshot: APFS clone the workspace into a per-box scratch dir.
  // Only the no-git, no-checkpoint path actually consumes the clone (as the
  // source of the tar pipe in seedWorkspaceFromDir). For the git path the
  // worktree content comes from `.git`'s object DB (bind-mounted) and the
  // untracked-file tar pipe reads from the live host main repo — neither
  // touches `snapshotDir`, so we skip it. For checkpoint restore there's no
  // seedWorkspace at all. Kept on the BoxRecord so destroyBox can clean it up.
  let snapshotDir: string | null = null;
  const snapshotIsUseful = !checkpointImage && repoCarryOvers.length === 0;
  if (opts.useSnapshot && snapshotIsUseful) {
    snapshotDir = snapshotPathFor({ id, name, projectIndex });
    log(`cloning workspace to ${snapshotDir} (APFS clone where available)`);
    const snap = await createSnapshot({ source: workspace, destination: snapshotDir });
    log(`pruned ${snap.prunedPaths.length} platform-dependent dirs from snapshot`);
  } else if (opts.useSnapshot && !checkpointImage) {
    log('skipping --host-snapshot: git worktree path reads content from .git, not from a workspace clone');
  }

  await ensureIdeVolumes(id);
  const dockerCacheShared = opts.docker?.sharedCache === true;
  const dockerVolume = dockerVolumeName(id, dockerCacheShared);
  await ensureVolume(dockerVolume);
  log(`prepared volumes ${vscodeServerVolumeName(id)}, ${cursorServerVolumeName(id)}, ${dockerVolume}`);
  const ide = buildIdeMounts(id);

  // Claude Code config volume. Shared by default so users sign in once across
  // every box; --isolate-claude-config opts into a per-box volume. Either way,
  // the host's ~/.claude is the authoritative source: we rsync host -> volume
  // on every create so updates on the host (new login, new skills, new MCP)
  // flow into the next box. Sync is additive — box-only state (session logs,
  // etc.) is preserved.
  const claudeSpec = resolveClaudeVolume({
    isolate: opts.claudeConfig?.isolate ?? false,
    boxId: id,
  });
  const claudeEnsured = await ensureClaudeVolume(claudeSpec, {
    syncFromHost: true,
    image: ensureRef,
    hostWorkspace: workspace,
  });
  if (claudeEnsured.synced) {
    log(`synced ${claudeSpec.volume} from ~/.claude`);
    if ((claudeEnsured.filteredHookCount ?? 0) > 0) {
      log(
        `filtered ${String(claudeEnsured.filteredHookCount)} host-path hook(s) (paths under ~/)`,
      );
    }
    if (claudeEnsured.installMethodFixed) {
      log('set installMethod=native in synced .claude.json (matches box native install)');
    }
    if (claudeEnsured.aliasedProjectKey) {
      log(`aliased project state for ${workspace} -> /workspace in synced .claude.json`);
    }
    if (claudeEnsured.workspaceTrusted) {
      log('pre-trusted /workspace in synced .claude.json (skips the trust dialog)');
    }
  } else if (claudeEnsured.created) {
    log(`created empty volume ${claudeSpec.volume} (no host ~/.claude to sync)`);
  } else {
    log(`reusing volume ${claudeSpec.volume} (no host ~/.claude to sync)`);
  }
  // Box-only: seed /agentbox-setup into the volume from the image. Never
  // touches the host's ~/.claude. Re-copied every run so an image upgrade
  // propagates to a long-lived shared volume.
  const seeded = await seedSetupSkillIntoVolume(claudeSpec.volume, ensureRef);
  if (seeded.seeded) log(`refreshed /agentbox-setup skill into ${claudeSpec.volume}`);
  // Mirror the in-box OAuth credentials with the host backup: extract a
  // box-written `.credentials.json` out to ~/.agentbox, or seed a fresh
  // volume from a previous box's login. Best-effort.
  const credSync = await syncClaudeCredentials(claudeSpec, {
    image: ensureRef,
    isolate: opts.claudeConfig?.isolate ?? false,
  });
  if (credSync.direction === 'extracted') {
    log('extracted box claude credentials to host backup');
  } else if (credSync.direction === 'seeded') {
    log(`seeded claude credentials into ${claudeSpec.volume} from host backup`);
  }
  const claudeMounts = buildClaudeMounts(claudeSpec, process.env);

  // Codex config volume. Mounted when the caller explicitly wants codex
  // (`agentbox codex` passes `codexConfig`) OR the host already uses codex
  // (`~/.codex` exists) — so a plain `agentbox create` for a Codex user still
  // gets a working box. Same host-authoritative additive sync as the claude
  // volume; `--isolate-codex-config` opts into a per-box volume.
  const wantCodex =
    opts.codexConfig !== undefined || (await pathExists(join(homedir(), '.codex')));
  let codexMounts: CodexMountResult | undefined;
  let codexConfigVolume: string | undefined;
  if (wantCodex) {
    const codexSpec = resolveCodexVolume({
      isolate: opts.codexConfig?.isolate ?? false,
      boxId: id,
    });
    const codexEnsured = await ensureCodexVolume(codexSpec, {
      syncFromHost: true,
      image: ensureRef,
    });
    if (codexEnsured.synced) log(`synced ${codexSpec.volume} from ~/.codex`);
    else if (codexEnsured.created) log(`created empty volume ${codexSpec.volume} (no host ~/.codex)`);
    else log(`reusing volume ${codexSpec.volume}`);
    // Box-only: seed the Codex activity hooks (~/.codex/hooks.json). Re-seeded
    // each create so an image upgrade propagates; never touches the host.
    const codexHooks = await seedCodexHooks(codexSpec.volume, ensureRef);
    if (codexHooks.seeded) log(`seeded Codex activity hooks into ${codexSpec.volume}`);
    codexMounts = buildCodexMounts(codexSpec, process.env);
    codexConfigVolume = codexSpec.volume;
  }

  // OpenCode config volume. Mounted when the caller wants opencode
  // (`agentbox opencode` passes `opencodeConfig`) OR the host already uses
  // OpenCode (`~/.config/opencode` or `~/.local/share/opencode` exists). One
  // volume holds both OpenCode dirs (data at the root, config in a `config/`
  // subdir via OPENCODE_CONFIG_DIR — see opencode.ts).
  const wantOpencode =
    opts.opencodeConfig !== undefined ||
    (await pathExists(join(homedir(), '.config', 'opencode'))) ||
    (await pathExists(join(homedir(), '.local', 'share', 'opencode')));
  let opencodeMounts: OpencodeMountResult | undefined;
  let opencodeConfigVolume: string | undefined;
  if (wantOpencode) {
    const opencodeSpec = resolveOpencodeVolume({
      isolate: opts.opencodeConfig?.isolate ?? false,
      boxId: id,
    });
    const opencodeEnsured = await ensureOpencodeVolume(opencodeSpec, {
      syncFromHost: true,
      image: ensureRef,
    });
    if (opencodeEnsured.synced) log(`synced ${opencodeSpec.volume} from ~/.config + ~/.local/share opencode`);
    else if (opencodeEnsured.created) log(`created empty volume ${opencodeSpec.volume} (no host opencode)`);
    else log(`reusing volume ${opencodeSpec.volume}`);
    // Seed the AgentBox state-reporting plugin from the image-baked copy.
    // OpenCode autoloads anything under $OPENCODE_CONFIG_DIR/plugins/; the
    // plugin shells `agentbox-ctl opencode-state` on each lifecycle event.
    const opencodePlugin = await seedOpencodePlugin(opencodeSpec.volume, ensureRef);
    if (opencodePlugin.seeded) log(`seeded agentbox-state plugin into ${opencodeSpec.volume}`);
    opencodeMounts = buildOpencodeMounts(opencodeSpec, process.env);
    opencodeConfigVolume = opencodeSpec.volume;
  }

  const boxDir = boxRunDirFor({ id, name, projectIndex });
  const socketDir = join(boxDir, 'run');
  const socketPath = join(socketDir, 'ctl.sock');
  // Per-box host dir that `agentbox open` refreshes the merged /workspace
  // into. Bound in at create time so `docker exec rsync` can write straight
  // to the host filesystem — no container restart needed.
  const mergedExportDir = join(boxDir, 'workspace');
  await mkdir(socketDir, { recursive: true });
  await mkdir(mergedExportDir, { recursive: true });

  const extraVolumes = await buildIdentityMounts();
  extraVolumes.push(...claudeMounts.extraVolumes);
  if (codexMounts) extraVolumes.push(...codexMounts.extraVolumes);
  if (opencodeMounts) extraVolumes.push(...opencodeMounts.extraVolumes);
  extraVolumes.push(...ide.extraVolumes);
  extraVolumes.push(`${socketDir}:/run/agentbox`);
  extraVolumes.push(`${mergedExportDir}:${CONTAINER_EXPORT_MERGED}`);
  // In-box dockerd's data root. Per-box (`agentbox-docker-<id>`, wiped on
  // destroy) by default; shared (`agentbox-docker-cache`, preserved) when
  // `box.dockerCacheShared` is set.
  extraVolumes.push(`${dockerVolume}:/var/lib/docker`);
  // Bind-mount each main repo's `.git/` at its identical absolute host path,
  // RW. The in-container `git worktree add` writes to <main>/.git/worktrees/
  // and the agent's commits write to refs/objects; both have to hit the same
  // path on host and inside the container so `git push` from the host main
  // repo sees the new commits without further sync.
  for (const w of gitWorktreeRecords) {
    extraVolumes.push(`${w.hostMainRepo}/.git:${w.hostMainRepo}/.git`);
  }

  // Portless: when enabled (and not OrbStack), (1) make the in-box browser
  // route the box's `<name>.localhost` URL out to the host proxy
  // (`portlessBrowserEnv`), and (2) bind-mount the host's Portless state dir so
  // the in-box `portless` CLI shares the host's route registry (discovery).
  // Best-effort; a missing host dir is created so the bind has a source.
  // PORTLESS_STATE_DIR pins both sides to the same path.
  const portlessEnv: Record<string, string> = {};
  if (opts.portless === true && (await detectEngine()) !== 'orbstack') {
    Object.assign(portlessEnv, portlessBrowserEnv(name, { mapTarget: 'host.docker.internal' }));
    try {
      const hostStateDir = await resolvePortlessHostStateDir(opts.portlessStateDir);
      await mkdir(hostStateDir, { recursive: true });
      const boxStateDir = '/home/vscode/.portless';
      extraVolumes.push(`${hostStateDir}:${boxStateDir}`);
      portlessEnv['PORTLESS_STATE_DIR'] = boxStateDir;
    } catch (err) {
      log(
        `portless: state-dir share skipped (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  for (const v of extraVolumes) log(`mounting agent dir: ${v}`);

  // Per-box bearer token for the host relay. Register *before* runBox so the
  // box's supervisor can post on boot. Skip if the relay isn't reachable —
  // the box still works, it just won't deliver events to the host.
  const relayToken = generateRelayToken();
  if (relayUp) {
    try {
      await registerBoxWithRelay({
        boxId: id,
        token: relayToken,
        name,
        containerName,
        createdAt,
        projectIndex,
        worktrees: gitWorktreeRecords,
      });
      log(`registered box token with relay`);
    } catch (err) {
      log(`relay register failed: ${err instanceof Error ? err.message : String(err)}`);
      relayUp = false;
    }
  }
  const relayEnv: Record<string, string> = relayUp
    ? {
        // The in-box ctl client always talks to its own in-box relay/forwarder
        // on AGENTBOX_BOX_RELAY_PORT (default 8788). For docker boxes the
        // forwarder transparently proxies to the host relay at
        // host.docker.internal:8787 (the matching `--add-host` is set in
        // runBox). This keeps :8787 inside the box free for a nested
        // agentbox to claim its own host relay.
        AGENTBOX_RELAY_URL: `http://127.0.0.1:8788`,
        AGENTBOX_RELAY_TOKEN: relayToken,
        AGENTBOX_HOST_RELAY_URL: `http://host.docker.internal:8787`,
      }
    : {};

  // VNC stack defaults on; the CLI surfaces `--no-vnc` for opt-out. Generate
  // the password and the port mapping up front so they're baked into the
  // container's env + `-p` flags before `docker run` — both must be set at
  // create time (env survives stop/start; port mappings are immutable).
  const vncEnabled = opts.vnc?.enabled !== false;
  const vncPassword = vncEnabled ? generateVncPassword() : undefined;
  const vncEnv: Record<string, string> = vncEnabled && vncPassword
    ? { AGENTBOX_VNC_PASSWORD: vncPassword }
    : {};
  const vncPortMappings = vncEnabled
    ? [{ hostPort: 0, containerPort: VNC_CONTAINER_PORT, hostIp: '127.0.0.1' }]
    : [];

  // Reserve the web port unconditionally: `docker run -p` is immutable, but the
  // `expose:`-flagged service is usually only known after the in-box wizard
  // writes agentbox.yaml. The supervisor forwards :80 to it later; here we just
  // guarantee a published host port exists for whenever that happens.
  const webPortMappings = [
    { hostPort: 0, containerPort: WEB_CONTAINER_PORT, hostIp: '127.0.0.1' },
  ];

  // Identity vars that make the box self-aware. `projectIndex` was allocated
  // earlier (right after `id`/`name`) so dir-segment helpers could see it; we
  // just read the binding here.
  const agentboxEnv: Record<string, string> = {
    AGENTBOX: '1',
    AGENTBOX_BOX_NAME: name,
    AGENTBOX_HOST_WORKSPACE: workspace,
    ...(opts.projectRoot ? { AGENTBOX_PROJECT_ROOT: opts.projectRoot } : {}),
    ...(projectIndex !== undefined
      ? { AGENTBOX_PROJECT_INDEX: String(projectIndex) }
      : {}),
  };
  const boxEnvForFile: Record<string, string> = {
    AGENTBOX_BOX_ID: id,
    ...agentboxEnv,
    ...portlessEnv,
  };

  // `--storage-opt size=` is only enforced by devicemapper/btrfs/zfs.
  const appliedLimits: BoxLimitSpec | undefined = opts.limits;
  let effectiveLimits = appliedLimits;
  if (appliedLimits?.disk) {
    const driver = await dockerStorageDriver();
    if (!/^(devicemapper|btrfs|zfs|windowsfilter)$/.test(driver)) {
      log(
        `warning: --disk/box.disk is a no-op on this engine (storage-driver=${driver || 'unknown'}); ignoring`,
      );
      effectiveLimits = { ...appliedLimits, disk: null };
    }
  }

  // Everything about the box that's known before `docker run`. Recorded
  // provisionally right after the container starts (below) so a failure during
  // the rest of finalization (seed, ctl/vnc/dockerd launch, port publish,
  // portless) still leaves a state.json record — destroy/prune resolve the box
  // by its real name from state.json instead of relying on the orphan-container
  // fallback, and the late-known fields (ports, portless, carry) are merged in
  // by the final `recordBox` on success.
  const baseRecord: BoxRecord = {
    id,
    name,
    container: containerName,
    image: imageRef,
    workspacePath: workspace,
    snapshotDir,
    socketPath,
    claudeConfigVolume: claudeSpec.volume,
    codexConfigVolume,
    opencodeConfigVolume,
    vscodeServerVolume: vscodeServerVolumeName(id),
    cursorServerVolume: cursorServerVolumeName(id),
    relayToken: relayUp ? relayToken : undefined,
    gitWorktrees: gitWorktreeRecords.length > 0 ? gitWorktreeRecords : undefined,
    withPlaywright: opts.withPlaywright ? true : undefined,
    withEnv: opts.withEnv ? true : undefined,
    vncEnabled: vncEnabled ? true : undefined,
    vncContainerPort: vncEnabled ? VNC_CONTAINER_PORT : undefined,
    vncPassword: vncPassword,
    webContainerPort: WEB_CONTAINER_PORT,
    dockerVolume,
    dockerCacheShared: dockerCacheShared || undefined,
    projectRoot: opts.projectRoot,
    projectIndex,
    checkpointImage,
    checkpointSource,
    resourceLimits: persistableLimits(effectiveLimits),
    createdAt,
  };

  await runBox({
    name: containerName,
    image: imageRef,
    extraVolumes,
    limits: effectiveLimits,
    portMappings: [...vncPortMappings, ...webPortMappings],
    env: {
      AGENTBOX_BOX_ID: id,
      ...agentboxEnv,
      ...claudeMounts.env,
      ...(codexMounts?.env ?? {}),
      ...(opencodeMounts?.env ?? {}),
      ...relayEnv,
      ...vncEnv,
      ...portlessEnv,
      ...(opts.claudeEnv ?? {}),
    },
  });
  log(`container ${containerName} started`);

  // Provisional registration: the box now exists, so persist it before the
  // remaining finalization steps. If create dies past this point, the record
  // (with the real name) is already in state.json for destroy/prune to find.
  await recordBox(baseRecord);

  // Flip the in-container parent dir of each bind-mounted `.git` to
  // vscode-owned. Docker auto-creates the intermediates (e.g. the project root
  // path that contains `.git`) as root:root 755 in the writable layer; without
  // this chown the agent can't write siblings of `.git` (`.turbo/`, `.next/`,
  // build caches) at the project root. Non-recursive — the bind-mounted `.git`
  // itself stays untouched (recursive chown would propagate to the host).
  if (gitWorktreeRecords.length > 0) {
    await chownGitBindParents({
      container: containerName,
      hostMainRepos: gitWorktreeRecords.map((w) => w.hostMainRepo),
      onLog: log,
    });
  }

  // /etc/agentbox/box.env: sourced by /etc/profile.d/agentbox.sh in login
  // shells (the docker-run env doesn't reach `agentbox shell <box>` cleanly
  // without it). Best-effort — env vars on the container are the primary
  // path; this file is for shells launched via tools that strip env.
  const boxEnv = await writeBoxEnvFile(containerName, boxEnvForFile);
  if (boxEnv.ok) log('wrote /etc/agentbox/box.env');
  else log(`writing /etc/agentbox/box.env failed: ${boxEnv.reason}`);

  // Re-own /home/vscode to vscode. Root-run exec steps (checkpoint cleanup,
  // dockerd setup) and boxes restored from a checkpoint can leave home-dir
  // files root-owned; the shell + agent run as vscode and would silently
  // fail to write them (e.g. dropped `.bash_history`). Best-effort.
  await ensureHomeOwnedByVscode(containerName);

  // Seed /workspace.
  //   - Checkpoint restore: the image already has the source box's per-box
  //     worktree dir populated; we only need to re-establish the bind mount
  //     onto /workspace (docker commit doesn't capture bind-mount content).
  //   - Git path: create in-container worktrees + bind + replay stash + untracked.
  //   - No-git path: tar-pipe host workspace (or its APFS clone) into
  //     /workspace (no bind — files live directly in the image's writable
  //     layer at /workspace).
  if (!checkpointImage) {
    if (repoCarryOvers.length > 0) {
      try {
        await seedWorkspace({
          container: containerName,
          repos: repoCarryOvers,
          fromBranch: opts.fromBranch,
          onLog: log,
        });
        log('seeded /workspace from in-container git worktree(s)');
      } catch (err) {
        // --use-branch seed failures are almost always "branch already used by
        // another worktree" (the host has it checked out). There's nothing
        // useful to inspect, and a leftover container + worktree registration
        // would block the next attempt, so tear it down. Other seed failures
        // keep the existing inspect-on-failure behavior.
        if (opts.useBranch !== undefined) {
          log(`seedWorkspace failed for --use-branch ${opts.useBranch}; cleaning up the box`);
          await execa('docker', ['rm', '-f', containerName], { reject: false });
          // Drop the provisional record written after runBox so we don't leave
          // a dangling state.json entry pointing at the now-removed container.
          await removeBoxRecord(id);
          for (const w of gitWorktreeRecords) {
            await removeInBoxWorktree({
              hostMainRepo: w.hostMainRepo,
              gitWorktreePath: w.gitWorktreePath,
            });
          }
        } else {
          log(`seedWorkspace failed; leaving ${containerName} running so you can inspect it`);
        }
        throw err;
      }
    } else {
      const source = snapshotDir ?? workspace;
      await seedWorkspaceFromDir({ container: containerName, hostSource: source, onLog: log });
    }
  } else if (restoreWorktreePlans.length > 0) {
    // gitWorktreeRecords was populated above (pre-`docker run`) with FRESH
    // per-box branches/paths, so the .git bind-mounts in extraVolumes are
    // wired. The container is now running, so regenerate each baked worktree
    // onto its fresh branch (rename + fresh metadata + reindex), then apply the
    // /workspace bind mount(s) onto the fresh paths.
    await regenerateRestoredWorktrees({
      container: containerName,
      plans: restoreWorktreePlans,
      fromBranch: opts.fromBranch,
      onLog: log,
    });
    await bindWorktrees(
      containerName,
      gitWorktreeRecords.map((w) => ({
        kind: w.kind,
        containerPath: w.containerPath,
        gitWorktreePath: w.gitWorktreePath,
      })),
      log,
    );
    log('re-bound /workspace from checkpoint image (fresh per-box worktree)');
    // Each fresh branch was forked from the host's base ref, and
    // regenerateRestoredWorktrees already `reset --hard`ed the tracked tree to
    // it (the checkpoint's stale tracked deviations are dropped; gitignored warm
    // artifacts like node_modules are kept). Resync then merges the host's
    // current branch in + overlays the host's uncommitted/untracked changes, so
    // the box matches a fresh create from HEAD (box wins on conflict).
    if (opts.resyncOnStart !== false) {
      const repos = await resyncWorkspaceFromHost({
        container: containerName,
        worktrees: gitWorktreeRecords,
        onLog: log,
      });
      resyncResult = {
        repos,
        hadConflicts: repos.some(
          (r) => r.mergeConflicts.length > 0 || r.overlaySkipped.length > 0,
        ),
      };
    }
  } else {
    log('using /workspace from checkpoint image (no worktrees recorded; no rebind)');
  }

  await repairIdeOwnership(containerName);
  log('.vscode-server + .cursor-server ownership verified');

  // dockerd: always-on, mirrors launchVncDaemon. Launched (and awaited ready)
  // BEFORE the ctl supervisor: the supervisor starts agentbox.yaml services as
  // soon as it's up, so a `docker run`/`docker compose` service must not race a
  // not-yet-ready /var/run/docker.sock. launchDockerdDaemon blocks until the
  // socket is accept()-able. Best-effort — a slow start shouldn't fail box
  // creation; `agentbox start` will relaunch on restart (the daemon dies with
  // the container). The storage driver is selected at runtime by
  // agentbox-dockerd-start (overlay2, with a fuse-overlayfs fallback) — see
  // /var/log/agentbox/dockerd.log inside the box.
  const dockerd = await launchDockerdDaemon(containerName);
  if (dockerd.up) {
    log(`dockerd up (data root=${dockerVolume})`);
  } else {
    log(`dockerd did not become ready: ${dockerd.reason}`);
  }

  const ctl = await launchCtlDaemon(containerName, socketPath);
  if (ctl.up) log('agentbox-ctl daemon up');
  else log(`agentbox-ctl daemon did not become reachable: ${ctl.reason}`);

  if (opts.withPlaywright) {
    log('installing @playwright/cli@latest (--with-playwright)');
    const result = await execa(
      'docker',
      [
        'exec',
        '--user',
        'root',
        containerName,
        'bash',
        '-lc',
        'npm install -g @playwright/cli@latest 2>&1',
      ],
      { reject: false },
    );
    for (const line of (result.stdout ?? '').split('\n')) {
      if (line.trim().length > 0) log(`[playwright] ${line}`);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `failed to install @playwright/cli (exit ${String(result.exitCode)}): ${(result.stderr ?? '').toString().slice(0, 400)}`,
      );
    }
    log('@playwright/cli installed');
  }

  if (opts.withEnv) {
    log('copying host env/config files into /workspace (--with-env)');
    const { copied } = await copyHostEnvFilesToBox({
      container: containerName,
      workspaceDir: workspace,
      patterns: DEFAULT_ENV_PATTERNS,
      onLog: log,
    });
    log(copied > 0 ? `copied ${String(copied)} env/config file(s)` : 'no env/config files found');
  }

  if (opts.envFilesToImport && opts.envFilesToImport.length > 0) {
    log(`copying ${String(opts.envFilesToImport.length)} selected env/config file(s) into /workspace`);
    const { copied } = await copyHostFilesToBox({
      container: containerName,
      workspaceDir: workspace,
      files: opts.envFilesToImport,
      onLog: log,
    });
    if (copied !== opts.envFilesToImport.length) {
      log(`copied ${String(copied)}/${String(opts.envFilesToImport.length)} selected env/config file(s)`);
    }
  }

  // carry: from agentbox.yaml — resolved and approved by the host CLI, then
  // threaded in here. Runs after the env-file copies and before the supervisor
  // launches so the first task can already see e.g. ~/.agentbox/secrets.env.
  let carrySummary: BoxRecord['carry'] | undefined;
  if (opts.carry && opts.carry.length > 0) {
    log(`carry: copying ${String(opts.carry.length)} host path(s) into the box`);
    const result = await copyCarryPathsToBox({
      container: containerName,
      entries: opts.carry,
      onLog: log,
    });
    log(`carry: copied ${String(result.copied)}/${String(opts.carry.length)} entry/entries`);
    for (const err of result.errors) log(`carry: ${err}`);
    if (result.applied.length > 0) {
      carrySummary = { count: result.applied.length, entries: result.applied };
    }
  }

  // VNC daemon (Xvnc + websockify). Best-effort, like launchCtlDaemon. The
  // host port mapping was wired into runBox above (hostPort=0 → random); we
  // resolve the assigned port here for storage. If the daemon fails to come
  // up we still record vncEnabled so `agentbox start` will retry the launch.
  let vncHostPort: number | null = null;
  if (vncEnabled) {
    const vnc = await launchVncDaemon(containerName);
    if (vnc.up) log('vnc stack up (Xvnc + websockify + noVNC)');
    else log(`vnc stack did not become reachable: ${vnc.reason}`);
    vncHostPort = await publishedHostPort(containerName, VNC_CONTAINER_PORT);
    if (vncHostPort) log(`vnc web on host 127.0.0.1:${String(vncHostPort)}`);
  }

  const webHostPort = await publishedHostPort(containerName, WEB_CONTAINER_PORT);
  if (webHostPort) {
    log(
      `web port reserved on host 127.0.0.1:${String(webHostPort)} ` +
        `(forwards to the web service once agentbox.yaml sets a service expose:)`,
    );
  }

  // Portless: register `https://<box-name>.localhost -> 127.0.0.1:<webHostPort>`
  // and a parallel `https://vnc-<box-name>.localhost -> 127.0.0.1:<vncHostPort>`
  // for the noVNC viewer. Best-effort — Portless is user-installed and never
  // required; any failure here just leaves the box on its loopback URL.
  // Skipped on OrbStack (which already has <container>.orb.local).
  let portlessAliasName: string | undefined;
  let portlessUrl: string | undefined;
  let portlessVncAliasName: string | undefined;
  let portlessVncUrl: string | undefined;
  if (opts.portless === true && (webHostPort || (vncEnabled && vncHostPort))) {
    try {
      const engine = await detectEngine();
      if (engine === 'orbstack') {
        log('portless: skipped (OrbStack already provides <container>.orb.local)');
      } else {
        const portless = await detectPortless();
        if (!portless.installed) {
          log('portless not installed — run `npm install -g portless` for a <name>.localhost URL');
        } else {
          if (webHostPort) {
            if (await portlessAlias(name, webHostPort)) {
              portlessAliasName = name;
              // Resolve the real URL from the proxy: scheme + port depend on how
              // the proxy was started (http://…:1355 no-TLS, or https://… on :443).
              portlessUrl = await portlessGetUrl(name);
              log(`portless alias ${portlessUrl} -> 127.0.0.1:${String(webHostPort)}`);
            } else {
              log('portless alias failed (best-effort) — box still reachable on the loopback URL');
            }
          }
          if (vncEnabled && vncHostPort) {
            const vncAlias = `vnc-${name}`;
            if (await portlessAlias(vncAlias, vncHostPort)) {
              portlessVncAliasName = vncAlias;
              portlessVncUrl = await portlessGetUrl(vncAlias);
              log(`portless alias ${portlessVncUrl} -> 127.0.0.1:${String(vncHostPort)}`);
            } else {
              log('portless vnc alias failed (best-effort) — VNC still reachable on the loopback URL');
            }
          }
          if (!portless.proxyRunning && (portlessAliasName || portlessVncAliasName)) {
            log(`portless proxy not running — start it with \`${portlessStartHint()}\``);
          }
        }
      }
    } catch (err) {
      log(`portless: ${err instanceof Error ? err.message : String(err)} (best-effort, ignored)`);
    }
  }

  // Final record: the provisional base plus the fields only known after the
  // container was up (published host ports, portless aliases, applied carry).
  const record: BoxRecord = {
    ...baseRecord,
    carry: carrySummary,
    vncHostPort: vncHostPort ?? undefined,
    webHostPort: webHostPort ?? undefined,
    portlessAlias: portlessAliasName,
    portlessUrl,
    portlessVncAlias: portlessVncAliasName,
    portlessVncUrl,
  };
  await recordBox(record);

  return { record, imageBuilt: built, resync: resyncResult };
}
