import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const STATE_DIR = join(homedir(), '.agentbox');
export const STATE_FILE = join(STATE_DIR, 'state.json');

export interface BoxRecord {
  id: string;
  name: string;
  container: string;
  image: string;
  workspacePath: string;
  lowerPath: string;
  upperVolume: string;
  nodeModulesVolume: string;
  snapshotDir: string | null;
  /**
   * Host-side path to the agentbox-ctl unix socket bind-mounted into the
   * container at /run/agentbox/ctl.sock. Absent for boxes created before this
   * field existed (treated as "ctl not available").
   */
  socketPath?: string;
  /**
   * Docker volume mounted at /home/vscode/.claude inside the box. The default
   * shared volume (`agentbox-claude-config`) is reused across boxes; isolated
   * boxes get a per-box volume suffixed with the box id. Absent for boxes
   * created before this field existed.
   */
  claudeConfigVolume?: string;
  /**
   * Per-box volume holding `.vscode-server` (server binary + TS cache).
   * The shared `agentbox-vscode-extensions` volume layers over the `extensions`
   * subdir at run time and isn't recorded here (never auto-removed). Absent
   * for boxes created before this field existed.
   */
  vscodeServerVolume?: string;
  /**
   * Per-box volume holding `.cursor-server` (Cursor server binary + state).
   * Parallel to `vscodeServerVolume`. Absent for boxes created before this
   * field existed — lifecycle code falls back to deriving from `id`.
   */
  cursorServerVolume?: string;
  /**
   * Bearer token the in-box supervisor uses to authenticate with the host
   * relay. Generated at create time and forwarded as AGENTBOX_RELAY_TOKEN.
   * Absent for boxes created before the relay existed — those boxes simply
   * skip outbound push.
   */
  relayToken?: string;
  /**
   * Git worktrees mounted into the box. Empty/absent when the host workspace
   * is not a git checkout. The root entry (kind: 'root') replaces the box's
   * overlay lower; nested entries (kind: 'nested', from monorepo 1st-level
   * `.git` dirs) are bind-mounted at /workspace/<relPathFromWorkspace> after
   * the FUSE overlay is mounted.
   */
  gitWorktrees?: GitWorktreeRecord[];
  /**
   * True when the box was created with --with-playwright. The install happens
   * once at create time (npm install -g @playwright/cli@latest inside the
   * container); we record the choice for `agentbox inspect` visibility. Absent
   * on boxes created before this field existed (treated as false).
   */
  withPlaywright?: boolean;
  /**
   * True when the box was created with --with-env. The host's env/config files
   * (DEFAULT_ENV_PATTERNS) were copied into /workspace once at create time,
   * bypassing gitignore; recorded for `agentbox inspect` visibility. Absent on
   * boxes created before this field existed (treated as false).
   */
  withEnv?: boolean;
  /**
   * VNC stack (Xvnc + websockify + noVNC) is enabled for this box. Absent on
   * boxes created before VNC support landed → treated as disabled.
   */
  vncEnabled?: boolean;
  /** Container-side noVNC web port. Fixed to 6080 today; here for future-proofing. */
  vncContainerPort?: number;
  /** Random host port Docker assigned to the noVNC web server (resolved via `docker port`). */
  vncHostPort?: number;
  /** Per-box password baked into Xvnc's PasswordFile and embedded in the auto-connect URL. */
  vncPassword?: string;
  /**
   * Container port reserved for the web service `expose:` forward. Fixed to 80
   * today; the `-p` mapping is created unconditionally at `create`. Absent on
   * boxes created before web-port reservation landed → no web endpoint until
   * the box is recreated.
   */
  webContainerPort?: number;
  /** Random host port Docker assigned to container :80 (resolved via `docker port`). */
  webHostPort?: number;
  /**
   * Volume mounted at /var/lib/docker for the in-box dockerd. Per-box
   * (`agentbox-docker-<id>`) by default; the shared `agentbox-docker-cache`
   * volume when `dockerCacheShared` is true. Absent on boxes created before
   * DinD landed — those boxes have no in-box dockerd at all.
   */
  dockerVolume?: string;
  /**
   * True when this box's `dockerVolume` is the shared cache. Tells `destroyBox`
   * to skip removal (the shared volume holds image layers other boxes may
   * reuse) and `pruneBoxes --all` to allowlist it.
   */
  dockerCacheShared?: boolean;
  /**
   * Absolute host path of the project this box belongs to. Set by `createBox`
   * from the CLI-supplied `findProjectRoot(workspacePath)` (nearest ancestor
   * dir holding `agentbox.yaml`, else workspacePath itself). Used by
   * `resolveBoxRef` + `autoPickProjectBox` to scope numeric refs and auto-pick
   * to the cwd's project. Absent on boxes created before this field existed —
   * those boxes are never auto-picked or matched by numeric index.
   */
  projectRoot?: string;
  /**
   * Monotonic 1-based index within `projectRoot`. Allocated once at create via
   * `allocateProjectIndex` and never recycled — destroying box #2 leaves a gap
   * (next new box is #3, not #2). Lets `agentbox open 3` mean the same box for
   * that box's whole lifetime.
   */
  projectIndex?: number;
  createdAt: string; // ISO-8601
}

export interface GitWorktreeRecord {
  kind: 'root' | 'nested';
  /** Host path to the main repo whose `.git/` is bind-mounted RW at the identical path inside the container. */
  hostMainRepo: string;
  /** Host path to the per-box worktree directory (under ~/.agentbox/boxes/<id>/worktrees/). */
  hostWorktreeDir: string;
  /** Container path that resolves to the worktree's working tree. /workspace for root, /workspace/<subpath> for nested. */
  containerPath: string;
  /** Branch the worktree was created on, e.g. `agentbox/<box-name>`. */
  branch: string;
  /** Workspace-relative path the repo was found at (empty string for root). */
  relPathFromWorkspace: string;
}

export interface StateFile {
  version: 1;
  boxes: BoxRecord[];
}

const EMPTY: StateFile = { version: 1, boxes: [] };

export async function readState(path: string = STATE_FILE): Promise<StateFile> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as StateFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.boxes)) {
      throw new Error(`unrecognized state file shape at ${path}`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY };
    }
    throw err;
  }
}

export async function writeState(state: StateFile, path: string = STATE_FILE): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export async function recordBox(box: BoxRecord, path: string = STATE_FILE): Promise<void> {
  const state = await readState(path);
  const next: StateFile = {
    version: 1,
    boxes: [...state.boxes.filter((b) => b.id !== box.id), box],
  };
  await writeState(next, path);
}

export async function removeBoxRecord(id: string, path: string = STATE_FILE): Promise<boolean> {
  const state = await readState(path);
  const before = state.boxes.length;
  const next: StateFile = {
    version: 1,
    boxes: state.boxes.filter((b) => b.id !== id),
  };
  if (next.boxes.length === before) return false;
  await writeState(next, path);
  return true;
}

export type FindBoxResult =
  | { kind: 'ok'; box: BoxRecord }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: BoxRecord[] };

/**
 * Resolve a user-supplied identifier against the state file. Matching
 * precedence mirrors `docker`'s container reference resolution:
 *
 *   1. exact id
 *   2. unique id prefix
 *   3. exact name
 *   4. exact container name
 *
 * Returns `'ambiguous'` if step 2 finds more than one match (steps 1, 3, 4
 * are exact-match so they cannot be ambiguous on their own).
 */
export function findBox(idOrName: string, state: StateFile): FindBoxResult {
  const q = idOrName.trim();
  if (q.length === 0) return { kind: 'none' };

  const exactId = state.boxes.find((b) => b.id === q);
  if (exactId) return { kind: 'ok', box: exactId };

  const prefixMatches = state.boxes.filter((b) => b.id.startsWith(q));
  if (prefixMatches.length === 1) return { kind: 'ok', box: prefixMatches[0]! };
  if (prefixMatches.length > 1) return { kind: 'ambiguous', matches: prefixMatches };

  const byName = state.boxes.find((b) => b.name === q);
  if (byName) return { kind: 'ok', box: byName };

  const byContainer = state.boxes.find((b) => b.container === q);
  if (byContainer) return { kind: 'ok', box: byContainer };

  return { kind: 'none' };
}

/**
 * Next monotonic 1-based index for the given project. Reads only `state.boxes`
 * — caller is responsible for persisting the assignment. Boxes without
 * `projectRoot` are ignored (legacy records); boxes in *other* projects are
 * also ignored. Indices are never recycled, so a destroyed #2 leaves a gap.
 */
export function allocateProjectIndex(state: StateFile, projectRoot: string): number {
  let max = 0;
  for (const b of state.boxes) {
    if (b.projectRoot !== projectRoot) continue;
    if (typeof b.projectIndex === 'number' && b.projectIndex > max) {
      max = b.projectIndex;
    }
  }
  return max + 1;
}

/**
 * Auto-pick when a command's `[box]` argument is omitted. Returns the unique
 * box for `projectRoot`, an `ambiguous` carrying all candidates so the CLI can
 * print a chooser, or `none`.
 */
export function autoPickProjectBox(state: StateFile, projectRoot: string): FindBoxResult {
  const matches = state.boxes.filter((b) => b.projectRoot === projectRoot);
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'ok', box: matches[0]! };
  return { kind: 'ambiguous', matches };
}

/**
 * Top-level resolver every CLI command goes through. Combines numeric-index
 * lookup with the legacy `findBox` matcher:
 *
 *   - `ref === undefined` and `projectRoot` known → autoPickProjectBox.
 *   - `ref` is a pure positive integer and `projectRoot` known → resolve as
 *     project index. **Never** falls through to `findBox` on miss, so
 *     `agentbox open 3` is reserved for the index and won't accidentally
 *     match a hex id like `3abc…`.
 *   - Otherwise → `findBox` (id → prefix → name → container).
 */
export function resolveBoxRef(
  ref: string | undefined,
  state: StateFile,
  projectRoot: string | undefined,
): FindBoxResult {
  if (ref === undefined) {
    if (projectRoot === undefined) return { kind: 'none' };
    return autoPickProjectBox(state, projectRoot);
  }
  const trimmed = ref.trim();
  if (projectRoot !== undefined && /^[1-9][0-9]*$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10);
    const hit = state.boxes.find(
      (b) => b.projectRoot === projectRoot && b.projectIndex === idx,
    );
    return hit ? { kind: 'ok', box: hit } : { kind: 'none' };
  }
  return findBox(trimmed, state);
}
