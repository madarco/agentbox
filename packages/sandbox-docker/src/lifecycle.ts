import { execa } from 'execa';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BoxState } from '@agentbox/core';
import { claudeSessionInfo, SHARED_CLAUDE_VOLUME, type ClaudeSessionInfo } from './claude.js';
import {
  BOXES_ROOT,
  boxRunDirFor,
  getHostPaths,
  openInFinder,
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
  removeContainer,
  removeVolume,
  startContainer,
  stopContainer,
  unpauseContainer,
} from './docker.js';
import { mountOverlay, verifyOverlay, type OverlayCheck } from './overlay.js';
import { launchCtlDaemon } from './ctl.js';
import { SNAPSHOTS_ROOT } from './snapshot.js';
import {
  findBox,
  readState,
  removeBoxRecord,
  type BoxRecord,
  type FindBoxResult,
} from './state.js';

export interface ListedBox extends BoxRecord {
  state: BoxState;
}

export async function listBoxes(): Promise<ListedBox[]> {
  const { boxes } = await readState();
  return Promise.all(
    boxes.map(async (b): Promise<ListedBox> => {
      const state = await inspectContainerStatus(b.container);
      return { ...b, state };
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
  await startContainer(box.container);
  await mountOverlay(box.container);
  const overlayChecks = await verifyOverlay(box.container);
  if (box.socketPath) {
    // The daemon died with the container; relaunch it. Best-effort, same as
    // create.ts — a missing config or other startup issue shouldn't block
    // resumption of the box itself.
    await launchCtlDaemon(box.container, box.socketPath);
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
  /** Host paths for `agentbox open` / `agentbox path`. */
  hostPaths: HostPaths;
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

  return {
    record,
    state,
    upperVolume: { name: record.upperVolume, mountpoint: upperMountpoint },
    snapshotSizeBytes,
    overlayMounted,
    dockerInspect: dockerJson,
    claudeSession,
    hostPaths,
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
  const beforeContainer = await inspectContainerStatus(box.container);
  await removeContainer(box.container);
  const afterContainer = await inspectContainerStatus(box.container);
  const removedContainer = beforeContainer !== 'missing' && afterContainer === 'missing';

  const removedVolumes: string[] = [];
  for (const v of [box.upperVolume, box.nodeModulesVolume]) {
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
    const expectedContainers = new Set(survivingBoxes.map((b) => b.container));
    const expectedVolumes = new Set<string>([
      ...survivingBoxes.flatMap((b) => [b.upperVolume, b.nodeModulesVolume]),
      ...survivingBoxes
        .map((b) => b.claudeConfigVolume)
        .filter((v): v is string => typeof v === 'string'),
      // The shared claude-config volume holds user identity across every box;
      // never reap it via prune even if no surviving box currently references it.
      SHARED_CLAUDE_VOLUME,
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
