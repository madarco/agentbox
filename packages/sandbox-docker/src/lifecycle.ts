import { execa } from 'execa';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BoxState } from '@agentbox/core';
import type { BoxStatus, ClaudeActivityState } from '@agentbox/ctl';
import { claudeSessionInfo, SHARED_CLAUDE_VOLUME, type ClaudeSessionInfo } from './claude.js';
import { removeBoxWorktree } from './git-worktree.js';
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
  inspectVolumeMountpoint,
  listAgentboxContainers,
  listAgentboxVolumes,
  pauseContainer,
  publishedHostPort,
  removeContainer,
  removeNetwork,
  removeVolume,
  startContainer,
  stopContainer,
  unpauseContainer,
} from './docker.js';
import {
  mountOverlay,
  verifyOverlay,
  type NestedWorktreeBind,
  type OverlayCheck,
} from './overlay.js';
import { launchCtlDaemon } from './ctl.js';
import { launchDockerdDaemon, SHARED_DOCKER_CACHE_VOLUME } from './dockerd.js';
import { launchVncDaemon, VNC_CONTAINER_PORT } from './vnc.js';
import { WEB_CONTAINER_PORT } from './web.js';
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
}

export async function listBoxes(): Promise<ListedBox[]> {
  const { boxes } = await readState();
  const engine = await detectEngine();
  return Promise.all(
    boxes.map(async (b): Promise<ListedBox> => {
      const state = await inspectContainerStatus(b.container);
      const persisted = await readBoxStatus(b.id);
      const endpoints = await getBoxEndpoints(b, engine, persisted);
      return { ...b, state, endpoints, claudeActivity: persisted?.claude.state };
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
  overlayChecks: OverlayCheck[];
}

export async function startBox(idOrName: string): Promise<StartedBox> {
  const box = await resolveBox(idOrName);
  // Bind mounts are baked into the container at create time; if a worktree
  // dir has been deleted out from under us we can't recover by restarting
  // (Docker just fails the start with an opaque mount error). Surface a clear
  // message up front so the user knows to recreate the box or restore the
  // worktree.
  for (const w of box.gitWorktrees ?? []) {
    if (!(await pathExists(w.hostWorktreeDir))) {
      throw new Error(`box worktree missing on host: ${w.hostWorktreeDir} (recreate the box)`);
    }
    if (!(await pathExists(join(w.hostMainRepo, '.git')))) {
      throw new Error(
        `main repo for box worktree missing: ${join(w.hostMainRepo, '.git')} (recreate the box)`,
      );
    }
  }
  await startContainer(box.container);
  const nestedWorktrees: NestedWorktreeBind[] = (box.gitWorktrees ?? [])
    .filter((w) => w.kind === 'nested')
    .map((w) => ({
      containerPath: w.containerPath,
      mountFromPath: `/agentbox-worktrees/${w.relPathFromWorkspace}`,
    }));
  await mountOverlay(box.container, { nestedWorktrees });
  const overlayChecks = await verifyOverlay(box.container);
  if (box.socketPath) {
    // The daemon died with the container; relaunch it. Best-effort, same as
    // create.ts — a missing config or other startup issue shouldn't block
    // resumption of the box itself.
    await launchCtlDaemon(box.container, box.socketPath);
  }
  // dockerd dies with the container too; relaunch it. Records from before
  // DinD landed have no `dockerVolume`, so we skip them — those boxes were
  // created without the in-box dockerd and don't have the launch script
  // baked in either (image rebuild is required to pick it up).
  if (box.dockerVolume) {
    await launchDockerdDaemon(box.container);
  }
  if (box.vncEnabled) {
    // Xvnc + websockify both die with the container. The password is already
    // in the container env (set at `docker run` time and preserved across
    // start/stop), so we don't need to forward it here.
    await launchVncDaemon(box.container);
    // Docker re-allocates an ephemeral host port for `-p 0:6080` on every
    // `start`, so the loopback URL from create time is stale. Re-resolve and
    // persist; the orb.local URL is name-based and unaffected. Best-effort —
    // a failed resolve just leaves the record as-is.
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
        worktrees: box.gitWorktrees,
      });
    } catch {
      // best-effort
    }
  }
  return { record: box, overlayChecks };
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
  upperVolume: { name: string; mountpoint: string | null };
  snapshotSizeBytes: number | null;
  overlayMounted: boolean;
  dockerInspect: unknown;
  /** Null when the container isn't running; otherwise best-effort probe of the tmux 'claude' session. */
  claudeSession: ClaudeSessionInfo | null;
  /** Persisted status snapshot (services/tasks/ports/claude); null when none. */
  persistedStatus: BoxStatus | null;
  /** Host paths for `agentbox open` / `agentbox path`. */
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
  const upperMountpoint = await inspectVolumeMountpoint(record.upperVolume);
  const snapshotSizeBytes = record.snapshotDir ? await dirSizeBytes(record.snapshotDir) : null;
  const dockerJson = await inspectContainer(record.container);

  let overlayMounted = false;
  if (state === 'running' || state === 'paused') {
    const probe = await execa(
      'docker',
      ['exec', '--user', 'root', record.container, 'mountpoint', '-q', '/workspace'],
      { reject: false },
    );
    overlayMounted = probe.exitCode === 0;
  }

  let claudeSession: ClaudeSessionInfo | null = null;
  if (state === 'running') {
    try {
      claudeSession = await claudeSessionInfo(record.container);
    } catch {
      claudeSession = null;
    }
  }

  const hostPaths = await getHostPaths(record);
  const engine = await detectEngine();
  const persistedStatus = await readBoxStatus(record.id);
  const endpoints = await getBoxEndpoints(record, engine, persistedStatus);

  return {
    record,
    state,
    upperVolume: { name: record.upperVolume, mountpoint: upperMountpoint },
    snapshotSizeBytes,
    overlayMounted,
    dockerInspect: dockerJson,
    claudeSession,
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
  // Remove the git worktrees on the host before nuking the container. The
  // worktree dirs live under the per-box run dir (which is wiped further
  // down), but we also need to deregister them from the main repo's
  // .git/worktrees/ so subsequent `git worktree list` on the host doesn't
  // see stale entries.
  for (const w of box.gitWorktrees ?? []) {
    try {
      await removeBoxWorktree({ hostMainRepo: w.hostMainRepo, worktreeDir: w.hostWorktreeDir });
    } catch {
      // best-effort
    }
  }
  const beforeContainer = await inspectContainerStatus(box.container);
  await removeContainer(box.container);
  const afterContainer = await inspectContainerStatus(box.container);
  const removedContainer = beforeContainer !== 'missing' && afterContainer === 'missing';

  const removedVolumes: string[] = [];
  // The dedicated agentbox-nm-<id> volume was removed (node_modules now lives
  // in the per-box overlay upper). Boxes created before that change still have
  // the volume on disk; removeVolume is a no-op for newer boxes that lack it.
  const legacyNodeModulesVolume = `agentbox-nm-${box.id}`;
  for (const v of [box.upperVolume, legacyNodeModulesVolume]) {
    await removeVolume(v);
    removedVolumes.push(v);
  }
  // Per-box claude config volumes are box-private — safe to remove. The shared
  // SHARED_CLAUDE_VOLUME holds user identity (auth, skills, plugins) across
  // every box, so never auto-remove it; users delete it manually if they want.
  if (box.claudeConfigVolume && box.claudeConfigVolume !== SHARED_CLAUDE_VOLUME) {
    await removeVolume(box.claudeConfigVolume);
    removedVolumes.push(box.claudeConfigVolume);
  }
  // Per-box `.vscode-server` and `.cursor-server` volumes. The shared
  // SHARED_*_EXTENSIONS_VOLUMEs are never auto-removed (parallel reasoning to
  // the shared claude volume). Volume names default-derived from `box.id` for
  // boxes created before these fields were recorded.
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

  // The per-box runtime dir holds the ctl socket plus the workspace/upper
  // export dirs used by `agentbox open`. Wipe the whole thing so destroy
  // leaves no residue under ~/.agentbox/boxes/.
  try {
    await rm(boxRunDirFor(box.id), { recursive: true, force: true });
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

export async function pruneBoxes(opts: PruneOptions = {}): Promise<PruneResult> {
  const dryRun = opts.dryRun ?? false;
  const all = opts.all ?? false;

  const { boxes } = await readState();

  // Step 1: missing-state records.
  const stateChecks = await Promise.all(
    boxes.map(async (b) => ({ box: b, status: await inspectContainerStatus(b.container) })),
  );
  const missingRecords = stateChecks.filter((c) => c.status === 'missing').map((c) => c.box);

  // Step 2 (only with --all): orphan docker containers / volumes / snapshot dirs / per-box dirs.
  let orphanContainers: string[] = [];
  let orphanVolumes: string[] = [];
  let orphanSnapshots: string[] = [];
  let orphanBoxDirs: string[] = [];

  if (all) {
    const liveContainers = await listAgentboxContainers();
    const liveVolumes = await listAgentboxVolumes();
    const liveSnapshotDirs = await listSnapshotDirs();
    const liveBoxDirs = await listBoxDirs();
    // The state we'd have AFTER step 1 runs: missing-state records gone.
    const survivingBoxes = boxes.filter((b) => !missingRecords.some((m) => m.id === b.id));
    const expectedContainers = new Set<string>([
      ...survivingBoxes.map((b) => b.container),
      // The relay no longer runs as a container (it's a host node process
      // now). Any agentbox-relay container is a leftover from a previous
      // version of agentbox; it will be collected as an orphan below.
    ]);
    const expectedVolumes = new Set<string>([
      // agentbox-nm-<id> reconstructed for back-compat: a surviving box
      // created before the nm volume was removed still mounts it, so it must
      // stay allowlisted. Inert for newer boxes (no such volume exists).
      ...survivingBoxes.flatMap((b) => [b.upperVolume, `agentbox-nm-${b.id}`]),
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
        .filter((b): b is BoxRecord & { snapshotDir: string } => b.snapshotDir !== null)
        .map((b) => b.snapshotDir),
    );
    const expectedBoxDirs = new Set(survivingBoxes.map((b) => boxRunDirFor(b.id)));
    orphanContainers = liveContainers.filter((c) => !expectedContainers.has(c));
    orphanVolumes = liveVolumes.filter((v) => !expectedVolumes.has(v));
    orphanSnapshots = liveSnapshotDirs.filter((d) => !expectedSnapshots.has(d));
    orphanBoxDirs = liveBoxDirs.filter((d) => !expectedBoxDirs.has(d));
  }

  if (dryRun) {
    return {
      removedRecords: missingRecords.map((b) => b.id),
      removedContainers: orphanContainers,
      removedVolumes: orphanVolumes,
      removedSnapshotDirs: orphanSnapshots,
      removedBoxDirs: orphanBoxDirs,
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
