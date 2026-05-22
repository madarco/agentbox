import { execa } from 'execa';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BoxState } from '@agentbox/core';
import type { BoxStatus, ClaudeActivityState } from '@agentbox/ctl';
import { claudeSessionInfo, SHARED_CLAUDE_VOLUME, type ClaudeSessionInfo } from './claude.js';
import { listShellSessions, type ShellSessionSummary } from './shell-session.js';
import { bindWorktrees, removeInBoxWorktree } from './in-box-git.js';
import {
  cursorServerVolumeName,
  SHARED_CURSOR_EXTENSIONS_VOLUME,
  SHARED_VSCODE_EXTENSIONS_VOLUME,
  vscodeServerVolumeName,
} from './vscode.js';
import {
  BOXES_ROOT,
  boxRunDirFor,
  detectEngine,
  getHostPaths,
  openInFinder,
  readBoxStatus,
  type HostPaths,
  type OpenOptions,
  type OpenResult,
} from './host-export.js';
import {
  inspectContainer,
  inspectContainerStatus,
  listAgentboxContainers,
  listAgentboxVolumes,
  pauseContainer,
  publishedHostPort,
  removeContainer,
  removeImage,
  removeNetwork,
  removeVolume,
  startContainer,
  stopContainer,
  unpauseContainer,
} from './docker.js';
import { CHECKPOINT_IMAGE_PREFIX, listAllCheckpointImages } from './checkpoint.js';
import { launchCtlDaemon } from './ctl.js';
import { ensureHomeOwnedByVscode } from './home-ownership.js';
import { launchDockerdDaemon, SHARED_DOCKER_CACHE_VOLUME } from './dockerd.js';
import { launchVncDaemon, VNC_CONTAINER_PORT } from './vnc.js';
import { WEB_CONTAINER_PORT } from './web.js';
import { detectPortless, portlessAlias, portlessGetUrl, portlessUnalias } from './portless.js';
import { getBoxEndpoints, type BoxEndpoints } from './endpoints.js';
import {
  ensureRelay,
  forgetBoxFromRelay,
  registerBoxWithRelay,
  RELAY_CONTAINER_NAME,
  RELAY_IMAGE_REF,
  RELAY_NETWORK_NAME,
} from './relay.js';
import { SNAPSHOTS_ROOT } from './snapshot.js';
import {
  findBox,
  readState,
  recordBox,
  removeBoxRecord,
  type BoxRecord,
  type FindBoxResult,
} from './state.js';

export interface ListedBox extends BoxRecord {
  state: BoxState;
  endpoints: BoxEndpoints;
  /** From the persisted status file; undefined for pre-feature/never-pushed boxes. */
  claudeActivity?: ClaudeActivityState;
  /** Sanitized in-box terminal title Claude set; undefined when none. */
  claudeSessionTitle?: string;
  /** Live shell tmux sessions; `[]` for non-running boxes (can't `docker exec`). */
  shellSessions: ShellSessionSummary[];
}

export async function listBoxes(): Promise<ListedBox[]> {
  const { boxes } = await readState();
  const engine = await detectEngine();
  return Promise.all(
    boxes.map(async (b): Promise<ListedBox> => {
      const state = await inspectContainerStatus(b.container);
      const persisted = await readBoxStatus(b);
      const endpoints = await getBoxEndpoints(b, engine, persisted);
      // Shell sessions are live tmux state — only a running container is
      // reachable via `docker exec`; paused/stopped report none.
      const shellSessions =
        state === 'running' ? await listShellSessions(b.container) : [];
      return {
        ...b,
        state,
        endpoints,
        claudeActivity: persisted?.claude.state,
        claudeSessionTitle: persisted?.claude.sessionTitle,
        shellSessions,
      };
    }),
  );
}

export class BoxNotFoundError extends Error {
  constructor(public readonly query: string) {
    super(`no agentbox matches "${query}"`);
    this.name = 'BoxNotFoundError';
  }
}

export class AmbiguousBoxError extends Error {
  constructor(
    public readonly query: string,
    public readonly matches: BoxRecord[],
  ) {
    const ids = matches.map((m) => m.id).join(', ');
    super(`"${query}" matches multiple boxes: ${ids}`);
    this.name = 'AmbiguousBoxError';
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveBox(idOrName: string): Promise<BoxRecord> {
  const state = await readState();
  const result: FindBoxResult = findBox(idOrName, state);
  switch (result.kind) {
    case 'ok':
      return result.box;
    case 'none':
      throw new BoxNotFoundError(idOrName);
    case 'ambiguous':
      throw new AmbiguousBoxError(idOrName, result.matches);
  }
}

export async function pauseBox(idOrName: string): Promise<BoxRecord> {
  const box = await resolveBox(idOrName);
  await pauseContainer(box.container);
  return box;
}

export async function unpauseBox(idOrName: string): Promise<BoxRecord> {
  const box = await resolveBox(idOrName);
  await unpauseContainer(box.container);
  return box;
}

export async function stopBox(idOrName: string): Promise<BoxRecord> {
  const box = await resolveBox(idOrName);
  await stopContainer(box.container);
  return box;
}

export interface StartedBox {
  record: BoxRecord;
}

/**
 * Re-start a stopped box.
 *
 * /workspace is just the container's writable filesystem now, so there's no
 * overlay to remount — `docker start` brings everything back. The in-box
 * supervisor, dockerd, and Xvnc all die with the container, so we relaunch
 * them via the same exec-d helpers `create` used. Ephemeral host ports for
 * VNC + web get re-allocated by Docker on `start`, so we re-resolve and
 * persist those too.
 */
export async function startBox(idOrName: string): Promise<StartedBox> {
  const box = await resolveBox(idOrName);
  // .git bind-mounts are baked into the container at create time; if a host
  // main repo's .git/ has been deleted out from under us, restart fails with
  // an opaque mount error. Surface it loudly.
  for (const w of box.gitWorktrees ?? []) {
    if (!(await pathExists(join(w.hostMainRepo, '.git')))) {
      throw new Error(
        `main repo for box worktree missing: ${join(w.hostMainRepo, '.git')} (recreate the box)`,
      );
    }
  }
  await startContainer(box.container);

  // /workspace bind mounts don't survive `docker stop` (the mount namespace
  // is recreated on start). Re-bind each registered worktree before any
  // daemon comes up — the supervisor and dockerd may resolve paths under
  // /workspace and would see the image's empty dir without this.
  if ((box.gitWorktrees ?? []).length > 0) {
    await bindWorktrees(
      box.container,
      (box.gitWorktrees ?? []).map((w) => ({
        kind: w.kind,
        containerPath: w.containerPath,
        gitWorktreePath: w.gitWorktreePath,
      })),
    );
  }

  // Re-own /home/vscode to vscode in case root-run steps left files behind
  // (see ensureHomeOwnedByVscode). Best-effort; safe to repeat.
  await ensureHomeOwnedByVscode(box.container);

  if (box.socketPath) {
    // The daemon died with the container; relaunch it. Best-effort, same as
    // create.ts — a missing config or other startup issue shouldn't block
    // resumption of the box itself.
    await launchCtlDaemon(box.container, box.socketPath);
  }
  if (box.dockerVolume) {
    await launchDockerdDaemon(box.container);
  }
  if (box.vncEnabled) {
    // Xvnc + websockify both die with the container. The password is already
    // in the container env (set at `docker run` time and preserved across
    // start/stop), so we don't need to forward it here.
    await launchVncDaemon(box.container);
    // Docker re-allocates an ephemeral host port for `-p 0:6080` on every
    // `start`. Re-resolve and persist; the orb.local URL is name-based and
    // unaffected. Best-effort — a failed resolve just leaves the record as-is.
    const freshHostPort = await publishedHostPort(box.container, VNC_CONTAINER_PORT);
    if (freshHostPort && freshHostPort !== box.vncHostPort) {
      box.vncHostPort = freshHostPort;
      await recordBox(box);
    }
  }
  // Same ephemeral-reallocation story for the reserved web port. Gated on
  // webContainerPort so pre-feature boxes (no `-p 0:80` mapping) are skipped.
  if (box.webContainerPort !== undefined) {
    const freshWebPort = await publishedHostPort(
      box.container,
      box.webContainerPort ?? WEB_CONTAINER_PORT,
    );
    if (freshWebPort && freshWebPort !== box.webHostPort) {
      box.webHostPort = freshWebPort;
      await recordBox(box);
    }
    // Docker reallocated the host port, so the Portless route now points at a
    // stale port — re-register it. Best-effort and silent (startBox has no
    // onLog); if the proxy/Portless is gone the box still works on loopback.
    if (box.portlessAlias && box.webHostPort) {
      try {
        const portless = await detectPortless();
        if (portless.installed) {
          await portlessAlias(box.portlessAlias, box.webHostPort);
          // The proxy's scheme/port can change between sessions — re-resolve.
          const url = await portlessGetUrl(box.portlessAlias);
          if (url !== box.portlessUrl) {
            box.portlessUrl = url;
            await recordBox(box);
          }
        }
      } catch {
        /* best-effort */
      }
    }
  }
  // Relay's in-memory registry may have been lost if the relay restarted
  // between create and now (or this is the first start after a host reboot).
  // Re-ensure + re-register so outbound push from the box keeps working.
  if (box.relayToken) {
    try {
      await ensureRelay();
      await registerBoxWithRelay({
        boxId: box.id,
        token: box.relayToken,
        name: box.name,
        containerName: box.container,
        createdAt: box.createdAt,
        projectIndex: box.projectIndex,
        worktrees: box.gitWorktrees,
      });
    } catch {
      // best-effort
    }
  }
  return { record: box };
}

export interface OpenedBox extends OpenResult {
  record: BoxRecord;
}

export async function openBoxInFinder(idOrName: string, opts: OpenOptions): Promise<OpenedBox> {
  const box = await resolveBox(idOrName);
  const result = await openInFinder(box, opts);
  return { ...result, record: box };
}

export async function getBoxHostPaths(
  idOrName: string,
): Promise<{ record: BoxRecord; paths: HostPaths }> {
  const box = await resolveBox(idOrName);
  const paths = await getHostPaths(box);
  return { record: box, paths };
}

export interface InspectedBox {
  record: BoxRecord;
  state: BoxState;
  snapshotSizeBytes: number | null;
  dockerInspect: unknown;
  /** Null when the container isn't running; otherwise best-effort probe of the tmux 'claude' session. */
  claudeSession: ClaudeSessionInfo | null;
  /** Live shell tmux sessions; `[]` when the container isn't running. */
  shellSessions: ShellSessionSummary[];
  /** Persisted status snapshot (services/tasks/ports/claude); null when none. */
  persistedStatus: BoxStatus | null;
  /** Host paths for `agentbox open`. */
  hostPaths: HostPaths;
  /** Box network surface: domain + VNC + service ports. */
  endpoints: BoxEndpoints;
}

async function dirSizeBytes(path: string): Promise<number | null> {
  try {
    const result = await execa('du', ['-sk', path], { reject: false });
    if (result.exitCode !== 0) return null;
    const sizeKb = Number.parseInt((result.stdout ?? '').split(/\s+/)[0] ?? '', 10);
    if (Number.isNaN(sizeKb)) return null;
    return sizeKb * 1024;
  } catch {
    return null;
  }
}

export async function inspectBox(idOrName: string): Promise<InspectedBox> {
  const record = await resolveBox(idOrName);
  const state = await inspectContainerStatus(record.container);
  const snapshotSizeBytes = record.snapshotDir ? await dirSizeBytes(record.snapshotDir) : null;
  const dockerJson = await inspectContainer(record.container);

  let claudeSession: ClaudeSessionInfo | null = null;
  let shellSessions: ShellSessionSummary[] = [];
  if (state === 'running') {
    try {
      claudeSession = await claudeSessionInfo(record.container);
    } catch {
      claudeSession = null;
    }
    shellSessions = await listShellSessions(record.container);
  }

  const hostPaths = await getHostPaths(record);
  const engine = await detectEngine();
  const persistedStatus = await readBoxStatus(record);
  const endpoints = await getBoxEndpoints(record, engine, persistedStatus);

  return {
    record,
    state,
    snapshotSizeBytes,
    dockerInspect: dockerJson,
    claudeSession,
    shellSessions,
    persistedStatus,
    hostPaths,
    endpoints,
  };
}

export interface DestroyOptions {
  keepSnapshot?: boolean;
}

export interface DestroyResult {
  record: BoxRecord;
  removedContainer: boolean;
  removedVolumes: string[];
  removedSnapshot: string | null;
}

export async function destroyBox(
  idOrName: string,
  opts: DestroyOptions = {},
): Promise<DestroyResult> {
  const box = await resolveBox(idOrName);

  // Each step is best-effort. We collect what actually went away so the CLI
  // can show a truthful summary even if e.g. the container was gone already.
  if (box.relayToken) {
    try {
      await forgetBoxFromRelay(box.id);
    } catch {
      // best-effort — relay may be down or already wiped the entry
    }
  }
  // Remove the Portless route so it doesn't dangle in the user's proxy config.
  if (box.portlessAlias) {
    try {
      await portlessUnalias(box.portlessAlias);
    } catch {
      // best-effort — Portless may be uninstalled or the route already gone
    }
  }
  // Deregister each in-container worktree from the host main repo. Skip
  // when this box was checkpoint-restored: its `gitWorktrees` were inherited
  // from the source box via the checkpoint manifest, and the same
  // `gitWorktreePath` may still be in use by the source (or by sibling
  // restores). Removing the registration here would break those. The
  // registration is cosmetically `prunable` on the host anyway (the path is
  // container-only) and can be reaped with `git worktree prune` when the
  // user is sure no box references it.
  const ownsWorktrees = !box.checkpointImage;
  if (ownsWorktrees) {
    for (const w of box.gitWorktrees ?? []) {
      try {
        await removeInBoxWorktree({
          hostMainRepo: w.hostMainRepo,
          gitWorktreePath: w.gitWorktreePath,
        });
      } catch {
        // best-effort
      }
    }
  }
  const beforeContainer = await inspectContainerStatus(box.container);
  await removeContainer(box.container);
  const afterContainer = await inspectContainerStatus(box.container);
  const removedContainer = beforeContainer !== 'missing' && afterContainer === 'missing';

  const removedVolumes: string[] = [];
  // Per-box claude config volumes are box-private — safe to remove. The shared
  // SHARED_CLAUDE_VOLUME holds user identity (auth, skills, plugins) across
  // every box, so never auto-remove it; users delete it manually if they want.
  if (box.claudeConfigVolume && box.claudeConfigVolume !== SHARED_CLAUDE_VOLUME) {
    await removeVolume(box.claudeConfigVolume);
    removedVolumes.push(box.claudeConfigVolume);
  }
  // Per-box `.vscode-server` and `.cursor-server` volumes. The shared
  // SHARED_*_EXTENSIONS_VOLUMEs are never auto-removed (parallel reasoning to
  // the shared claude volume).
  const perBoxIdeVolumes = [
    box.vscodeServerVolume ?? vscodeServerVolumeName(box.id),
    box.cursorServerVolume ?? cursorServerVolumeName(box.id),
  ];
  for (const v of perBoxIdeVolumes) {
    await removeVolume(v);
    removedVolumes.push(v);
  }
  // Per-box dockerd data root. Skip when this box used the shared cache —
  // wiping it would also remove image layers other boxes (or future ones)
  // depend on. The shared volume is allowlisted in `pruneBoxes --all` too.
  if (box.dockerVolume && !box.dockerCacheShared) {
    await removeVolume(box.dockerVolume);
    removedVolumes.push(box.dockerVolume);
  }

  let removedSnapshot: string | null = null;
  if (box.snapshotDir && !opts.keepSnapshot) {
    try {
      await rm(box.snapshotDir, { recursive: true, force: true });
      removedSnapshot = box.snapshotDir;
    } catch {
      removedSnapshot = null;
    }
  }

  // The per-box runtime dir holds the ctl socket plus the workspace export
  // dir used by `agentbox open`. Wipe the whole thing so destroy leaves no
  // residue under ~/.agentbox/boxes/.
  try {
    await rm(boxRunDirFor(box), { recursive: true, force: true });
  } catch {
    // best-effort
  }

  await removeBoxRecord(box.id);

  return { record: box, removedContainer, removedVolumes, removedSnapshot };
}

export interface PruneOptions {
  dryRun?: boolean;
  all?: boolean;
}

export interface PruneResult {
  removedRecords: string[];
  removedContainers: string[];
  removedVolumes: string[];
  removedSnapshotDirs: string[];
  removedBoxDirs: string[];
  removedCheckpointImages: string[];
  dryRun: boolean;
}

async function listSnapshotDirs(): Promise<string[]> {
  try {
    const entries = await readdir(SNAPSHOTS_ROOT, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(SNAPSHOTS_ROOT, e.name));
  } catch {
    return [];
  }
}

async function listBoxDirs(): Promise<string[]> {
  try {
    const entries = await readdir(BOXES_ROOT, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(BOXES_ROOT, e.name));
  } catch {
    return [];
  }
}

/**
 * Local Docker image *tags* that look like checkpoint images
 * (`agentbox-ckpt-<projectHash>:<name>`). Used by `prune --all` to find
 * candidates for reaping. An image is reapable only when **both** of these
 * are true: no surviving box's `checkpointImage` points at it, **and** no
 * on-disk manifest under `~/.agentbox/checkpoints/<projectHash>/<name>/`
 * names it as its `image` (see `listAllCheckpointImages`) — otherwise a
 * `destroy` + `prune --all` would silently break checkpoints the user still
 * intends to start new boxes from. Best-effort: returns empty on docker
 * errors.
 */
async function listCheckpointImageTags(): Promise<string[]> {
  const r = await execa(
    'docker',
    ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', `${CHECKPOINT_IMAGE_PREFIX}*`],
    { reject: false },
  );
  if (r.exitCode !== 0) return [];
  return (r.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(CHECKPOINT_IMAGE_PREFIX));
}

export async function pruneBoxes(opts: PruneOptions = {}): Promise<PruneResult> {
  const dryRun = opts.dryRun ?? false;
  const all = opts.all ?? false;

  const { boxes } = await readState();

  // Step 1: missing-state records.
  const stateChecks = await Promise.all(
    boxes.map(async (b) => ({ box: b, status: await inspectContainerStatus(b.container) })),
  );
  const missingRecords = stateChecks.filter((c) => c.status === 'missing').map((c) => c.box);

  // Step 2 (only with --all): orphan docker containers / volumes / snapshot
  // dirs / per-box dirs / unreferenced checkpoint images.
  let orphanContainers: string[] = [];
  let orphanVolumes: string[] = [];
  let orphanSnapshots: string[] = [];
  let orphanBoxDirs: string[] = [];
  let orphanCheckpointImages: string[] = [];

  if (all) {
    const liveContainers = await listAgentboxContainers();
    const liveVolumes = await listAgentboxVolumes();
    const liveSnapshotDirs = await listSnapshotDirs();
    const liveBoxDirs = await listBoxDirs();
    const liveCheckpointImages = await listCheckpointImageTags();
    // Manifests on disk are the durable source of truth for "this checkpoint
    // exists" — `destroyBox` leaves them alone on purpose, so an image whose
    // source box was destroyed is still pinned as long as its manifest is
    // there.
    const manifestPinnedImages = await listAllCheckpointImages();
    // The state we'd have AFTER step 1 runs: missing-state records gone.
    const survivingBoxes = boxes.filter((b) => !missingRecords.some((m) => m.id === b.id));
    const expectedContainers = new Set<string>([
      ...survivingBoxes.map((b) => b.container),
      // The relay no longer runs as a container; leftovers are collected
      // below.
    ]);
    const expectedVolumes = new Set<string>([
      ...survivingBoxes
        .map((b) => b.claudeConfigVolume)
        .filter((v): v is string => typeof v === 'string'),
      ...survivingBoxes
        .map((b) => b.vscodeServerVolume)
        .filter((v): v is string => typeof v === 'string'),
      ...survivingBoxes
        .map((b) => b.cursorServerVolume)
        .filter((v): v is string => typeof v === 'string'),
      ...survivingBoxes
        .map((b) => b.dockerVolume)
        .filter((v): v is string => typeof v === 'string'),
      // The shared claude-config volume holds user identity across every box;
      // never reap it via prune even if no surviving box currently references it.
      SHARED_CLAUDE_VOLUME,
      // Shared across boxes: downloaded IDE extensions. Same reasoning.
      SHARED_VSCODE_EXTENSIONS_VOLUME,
      SHARED_CURSOR_EXTENSIONS_VOLUME,
      // Shared in-box docker image cache — opt-in via `box.dockerCacheShared`,
      // never auto-removed (image layers may be reused by future boxes).
      SHARED_DOCKER_CACHE_VOLUME,
    ]);
    const expectedSnapshots = new Set(
      survivingBoxes
        .filter((b): b is BoxRecord & { snapshotDir: string } =>
          typeof b.snapshotDir === 'string',
        )
        .map((b) => b.snapshotDir),
    );
    const expectedBoxDirs = new Set(survivingBoxes.map((b) => boxRunDirFor(b)));
    // Checkpoint images: keep any tag that either a surviving box's
    // `checkpointImage` points at, or that any on-disk manifest still claims
    // as its `image`. The manifest case is the one that matters most after
    // destroy: the source box is gone but the user still wants to seed new
    // boxes from the checkpoint. The surviving-box case stays as a fallback
    // for the edge where someone `rm -rf`'d a manifest dir while a box
    // restored from it is still running.
    const expectedCheckpointImages = new Set<string>([
      ...survivingBoxes
        .map((b) => b.checkpointImage)
        .filter((v): v is string => typeof v === 'string'),
      ...manifestPinnedImages,
    ]);
    orphanContainers = liveContainers.filter((c) => !expectedContainers.has(c));
    orphanVolumes = liveVolumes.filter((v) => !expectedVolumes.has(v));
    orphanSnapshots = liveSnapshotDirs.filter((d) => !expectedSnapshots.has(d));
    orphanBoxDirs = liveBoxDirs.filter((d) => !expectedBoxDirs.has(d));
    orphanCheckpointImages = liveCheckpointImages.filter(
      (t) => !expectedCheckpointImages.has(t),
    );
  }

  if (dryRun) {
    return {
      removedRecords: missingRecords.map((b) => b.id),
      removedContainers: orphanContainers,
      removedVolumes: orphanVolumes,
      removedSnapshotDirs: orphanSnapshots,
      removedBoxDirs: orphanBoxDirs,
      removedCheckpointImages: orphanCheckpointImages,
      dryRun: true,
    };
  }

  for (const b of missingRecords) await removeBoxRecord(b.id);
  for (const c of orphanContainers) await removeContainer(c);
  for (const v of orphanVolumes) await removeVolume(v);
  for (const d of orphanSnapshots) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  for (const d of orphanBoxDirs) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  for (const img of orphanCheckpointImages) {
    await removeImage(img, { force: true });
  }

  // Migration sweep: the relay used to be a docker container on a dedicated
  // network with its own image. None of those exist after this version of
  // agentbox; drop any leftovers from previous installs. Idempotent and
  // best-effort — these calls succeed silently if the objects are already
  // gone.
  if (all) {
    try {
      await removeContainer(RELAY_CONTAINER_NAME);
    } catch {
      // best-effort
    }
    try {
      await execa('docker', ['image', 'rm', RELAY_IMAGE_REF], { reject: false });
    } catch {
      // best-effort
    }
    try {
      await removeNetwork(RELAY_NETWORK_NAME);
    } catch {
      // best-effort
    }
  }

  return {
    removedRecords: missingRecords.map((b) => b.id),
    removedContainers: orphanContainers,
    removedVolumes: orphanVolumes,
    removedSnapshotDirs: orphanSnapshots,
    removedBoxDirs: orphanBoxDirs,
    removedCheckpointImages: orphanCheckpointImages,
    dryRun: false,
  };
}

// Help vitest / unit tests get to the snapshot-root constant without pulling
// the whole snapshot module surface.
export { SNAPSHOTS_ROOT };

// Re-export the file existence helper for inspect output; useful guard for
// callers that want to know if a snapshot dir was ever created.
export async function snapshotPresent(path: string | null): Promise<boolean> {
  if (!path) return false;
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
