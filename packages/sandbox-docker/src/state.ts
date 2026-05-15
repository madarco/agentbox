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
