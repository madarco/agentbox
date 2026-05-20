import { randomBytes } from 'node:crypto';
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
  collectRepoCarryOver,
  gitWorktreePathFor,
  seedWorkspace,
  seedWorkspaceFromDir,
  type RepoCarryOver,
} from './in-box-git.js';
import {
  CONTAINER_EXPORT_MERGED,
  DEFAULT_ENV_PATTERNS,
  boxRunDirFor,
  copyHostEnvFilesToBox,
} from './host-export.js';
import { DEFAULT_BOX_IMAGE, ensureImage } from './image.js';
import {
  allocateProjectIndex,
  readState,
  recordBox,
  type BoxRecord,
  type GitWorktreeRecord,
} from './state.js';
import { createSnapshot, snapshotPathFor } from './snapshot.js';
import { resolveCheckpoint } from './checkpoint.js';
import { launchCtlDaemon } from './ctl.js';
import { writeBoxEnvFile } from './box-env.js';
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
  image?: string;
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

function generateBoxId(): string {
  return randomBytes(4).toString('hex');
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

// ~/.claude is intentionally NOT in this list: it lives in the named volume
// `agentbox-claude-config` (see resolveClaudeVolume / ensureClaudeVolume) so
// auth persists inside the container without leaking host state. Only
// non-claude identity files are bind-mounted from the host.
async function buildIdentityMounts(): Promise<string[]> {
  const home = homedir();
  const candidates: Array<{ src: string; dst: string; readOnly: boolean }> = [
    { src: join(home, '.codex'), dst: '/home/vscode/.codex', readOnly: false },
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
  }

  const imageRef = checkpointImage ?? opts.image ?? DEFAULT_BOX_IMAGE;
  // ensureImage only acts on the base image; checkpoint images are local-only
  // and must already exist (they were created by `agentbox checkpoint`).
  const ensureRef = checkpointImage ? (opts.image ?? DEFAULT_BOX_IMAGE) : imageRef;
  const { built } = await ensureImage(ensureRef, {
    onProgress: (line) => log(`[image] ${line}`),
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
  if (checkpointImage && restoredWorktrees && restoredWorktrees.length > 0) {
    gitWorktreeRecords.push(...restoredWorktrees);
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
      const branchBase =
        r.kind === 'root'
          ? `agentbox/${name}`
          : `agentbox/${name}--${r.relPathFromWorkspace.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
      const branch = await pickFreshBranch(r.hostMainRepo, branchBase);
      const containerPath =
        r.kind === 'root' ? '/workspace' : `/workspace/${r.relPathFromWorkspace}`;
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
    snapshotDir = snapshotPathFor(id);
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
    if (claudeEnsured.clearedInstallMethod) {
      log("cleared host's installMethod from synced .claude.json (box uses the native installer)");
    }
    if (claudeEnsured.aliasedProjectKey) {
      log(`aliased project state for ${workspace} -> /workspace in synced .claude.json`);
    }
  } else if (claudeEnsured.created) {
    log(`created empty volume ${claudeSpec.volume} (no host ~/.claude to sync)`);
  } else {
    log(`reusing volume ${claudeSpec.volume} (no host ~/.claude to sync)`);
  }
  // Box-only: seed /agentbox-setup into the volume from the image. Never
  // touches the host's ~/.claude. Skipped if a copy already exists.
  const seeded = await seedSetupSkillIntoVolume(claudeSpec.volume, ensureRef);
  if (seeded.seeded) log(`seeded /agentbox-setup skill into ${claudeSpec.volume}`);
  const claudeMounts = buildClaudeMounts(claudeSpec, process.env);

  const boxDir = boxRunDirFor(id);
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
        // host.docker.internal resolves to the host (where the relay node
        // process is running). The matching `--add-host` is set in runBox.
        AGENTBOX_RELAY_URL: `http://host.docker.internal:8787`,
        AGENTBOX_RELAY_TOKEN: relayToken,
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

  // Per-project monotonic index. Allocated *before* runBox so it can be
  // injected as AGENTBOX_PROJECT_INDEX in the container env.
  let projectIndex: number | undefined;
  if (opts.projectRoot) {
    projectIndex = allocateProjectIndex(await readState(), opts.projectRoot);
  }

  // Identity vars that make the box self-aware.
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
      ...relayEnv,
      ...vncEnv,
      ...(opts.claudeEnv ?? {}),
    },
  });
  log(`container ${containerName} started`);

  // /etc/agentbox/box.env: sourced by /etc/profile.d/agentbox.sh in login
  // shells (the docker-run env doesn't reach `agentbox shell <box>` cleanly
  // without it). Best-effort — env vars on the container are the primary
  // path; this file is for shells launched via tools that strip env.
  const boxEnv = await writeBoxEnvFile(containerName, boxEnvForFile);
  if (boxEnv.ok) log('wrote /etc/agentbox/box.env');
  else log(`writing /etc/agentbox/box.env failed: ${boxEnv.reason}`);

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
        await seedWorkspace({ container: containerName, repos: repoCarryOvers, onLog: log });
        log('seeded /workspace from in-container git worktree(s)');
      } catch (err) {
        log(
          `seedWorkspace failed; leaving ${containerName} running so you can inspect it`,
        );
        throw err;
      }
    } else {
      const source = snapshotDir ?? workspace;
      await seedWorkspaceFromDir({ container: containerName, hostSource: source, onLog: log });
    }
  } else if (restoredWorktrees && restoredWorktrees.length > 0) {
    // gitWorktreeRecords was populated above (pre-`docker run`) so the .git
    // bind-mounts in extraVolumes are wired. The /workspace bind itself
    // can't be set up until the container is running, so we apply it here.
    await bindWorktrees(
      containerName,
      restoredWorktrees.map((w) => ({
        kind: w.kind,
        containerPath: w.containerPath,
        gitWorktreePath: w.gitWorktreePath,
      })),
      log,
    );
    log('re-bound /workspace from checkpoint image');
  } else {
    log('using /workspace from checkpoint image (no worktrees recorded; no rebind)');
  }

  await repairIdeOwnership(containerName);
  log('.vscode-server + .cursor-server ownership verified');

  const ctl = await launchCtlDaemon(containerName, socketPath);
  if (ctl.up) log('agentbox-ctl daemon up');
  else log(`agentbox-ctl daemon did not become reachable: ${ctl.reason}`);

  // dockerd: always-on, mirrors launchVncDaemon. Best-effort — a slow start
  // shouldn't fail box creation; `agentbox start` will relaunch on restart
  // (the daemon dies with the container). Storage driver is fuse-overlayfs,
  // pinned in /etc/docker/daemon.json baked into the image.
  const dockerd = await launchDockerdDaemon(containerName);
  if (dockerd.up) {
    log(`dockerd up (storage-driver=fuse-overlayfs, data root=${dockerVolume})`);
  } else {
    log(`dockerd did not become ready: ${dockerd.reason}`);
  }

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

  const record: BoxRecord = {
    id,
    name,
    container: containerName,
    image: imageRef,
    workspacePath: workspace,
    snapshotDir,
    socketPath,
    claudeConfigVolume: claudeSpec.volume,
    vscodeServerVolume: vscodeServerVolumeName(id),
    cursorServerVolume: cursorServerVolumeName(id),
    relayToken: relayUp ? relayToken : undefined,
    gitWorktrees: gitWorktreeRecords.length > 0 ? gitWorktreeRecords : undefined,
    withPlaywright: opts.withPlaywright ? true : undefined,
    withEnv: opts.withEnv ? true : undefined,
    vncEnabled: vncEnabled ? true : undefined,
    vncContainerPort: vncEnabled ? VNC_CONTAINER_PORT : undefined,
    vncHostPort: vncHostPort ?? undefined,
    vncPassword: vncPassword,
    webContainerPort: WEB_CONTAINER_PORT,
    webHostPort: webHostPort ?? undefined,
    dockerVolume,
    dockerCacheShared: dockerCacheShared || undefined,
    projectRoot: opts.projectRoot,
    projectIndex,
    checkpointImage,
    checkpointSource,
    resourceLimits: persistableLimits(effectiveLimits),
    createdAt,
  };
  await recordBox(record);

  return { record, imageBuilt: built };
}
