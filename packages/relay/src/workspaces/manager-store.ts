/**
 * Where a manager RECORD lives, as opposed to where the manager RUNS.
 *
 * A manager is a coding agent in a folder on the user's machine: its tmux
 * server, its pid and its transcript are all there, so start/resume/stop/attach
 * can only ever run on that machine. The record — who it is, what it noted, the
 * tasks and boxes it owns — belongs with the workspace, which lives on the hub
 * that owns the boxes. With a control box configured those two are different
 * machines, and this seam is the join: the PC hub drives the process locally and
 * persists through the control box's `/api/v1`.
 *
 * Only three writes travel: a REGISTRATION (a start or resume produced a
 * session), a HEARTBEAT (what this machine's probes see right now) and a BOX
 * ATTACH (this machine built a box for that manager — a fact only it has, and
 * an append to a list of ids). Everything else a control box refuses from
 * another host, because it cannot be checked there.
 */
import { resolveControlBox, type ControlBoxTarget } from './control-box.js';
import {
  applyManagerPatch,
  attachBoxToManager,
  findManager,
  findManagerBySession,
  patchManager,
  readManagers,
  registeredManager,
  removeManagerRecord,
  updateManagers,
  upsertDetectedManager,
  type DetectManagerInput,
} from './manager.js';
import { listWorkspaces, readWorkspace } from './workspace-store.js';
import type {
  ManagerHeartbeat,
  ManagerRecord,
  ManagerRecordPatch,
  ManagerRegistration,
  ManagerView,
} from './types.js';

/**
 * What the manager layer needs of a workspace: its name (a view's label) and the
 * folder each machine holds (where a session may be started, and whose agent
 * sessions may be listed). Narrower than `WorkspaceRecord` on purpose — a remote
 * store reads the API view, which has no on-disk counter or version.
 */
export interface ManagerWorkspace {
  id: string;
  name: string;
  hosts: Record<string, { root: string }>;
}

/** What a manager's create produced: the box, or the job still building it. */
export type ManagerBoxTarget = { boxId: string } | { boxJobId: string };

export interface DetectedManager {
  manager: ManagerRecord;
  created: boolean;
  sessionChanged: boolean;
}

export interface ManagerRecordStore {
  /** `file` is this machine's disk; `remote` is the control box's `/api/v1`. */
  readonly kind: 'file' | 'remote';
  /** Every record, for a lookup that has only an id or a session. */
  listManagers(): Promise<ManagerRecord[]>;
  readManagers(wsId: string): Promise<ManagerRecord[]>;
  /** The workspace a manager belongs to, from wherever the record lives. */
  readWorkspace(wsId: string): Promise<ManagerWorkspace | null>;
  findManager(id: string): Promise<ManagerRecord | null>;
  findManagerBySession(agent: string, sessionId: string): Promise<ManagerRecord | null>;
  /** Persist the session a start or resume just opened on this machine. */
  registerManager(wsId: string, input: ManagerRegistration): Promise<ManagerRecord | null>;
  /** Report what this machine's probes see for a record it hosts. */
  reportManager(id: string, beat: ManagerHeartbeat): Promise<void>;
  /**
   * Record that a box (or the job building one) belongs to a manager. Travels,
   * unlike the other patches: the hub that BUILT the box is the only one that
   * knows, and with `hub.mode=local` under a control box that is not the hub
   * holding the record.
   */
  attachBox(wsId: string, id: string, target: ManagerBoxTarget): Promise<void>;
  patchManager(wsId: string, id: string, patch: ManagerRecordPatch): Promise<ManagerRecord | null>;
  upsertDetectedManager(wsId: string, input: DetectManagerInput): Promise<DetectedManager>;
  removeManagerRecord(wsId: string, id: string): Promise<boolean>;
  /**
   * The views the store's own hub renders, or `null` when the caller should
   * render them itself. A remote store answers with the control box's views —
   * it holds the workspace names, the tasks and every other host's heartbeats,
   * none of which this machine has.
   */
  managerViews(filter?: { workspaceId?: string }): Promise<ManagerView[] | null>;
  managerView(id: string): Promise<ManagerView | null | undefined>;
}

export function fileManagerStore(): ManagerRecordStore {
  return {
    kind: 'file',
    async listManagers() {
      const out: ManagerRecord[] = [];
      for (const ws of await listWorkspaces()) out.push(...(await readManagers(ws.id)));
      return out;
    },
    readManagers,
    readWorkspace,
    findManager,
    findManagerBySession,
    async registerManager(wsId, input) {
      return updateManagers(wsId, (managers) => {
        const idx = input.id ? managers.findIndex((m) => m.id === input.id) : -1;
        const next = registeredManager(wsId, input, idx === -1 ? undefined : managers[idx]);
        const out = [...managers];
        if (idx === -1) out.push(next);
        else out[idx] = next;
        return { managers: out, result: next };
      });
    },
    // A record on this disk is probed, never reported: the reading hub IS the
    // machine, so a heartbeat would only restate what it can see.
    reportManager: async () => {},
    async attachBox(wsId, id, target) {
      await attachBoxToManager(wsId, id, target);
    },
    patchManager: (wsId, id, patch) =>
      patchManager(wsId, id, (rec) => applyManagerPatch(rec, patch)),
    upsertDetectedManager: (wsId, input) => upsertDetectedManager(wsId, input),
    removeManagerRecord,
    managerViews: async () => null,
    managerView: async () => undefined,
  };
}

export interface RemoteManagerStoreOptions {
  fetchImpl?: typeof fetch;
  /** Called once per process the first time the control box cannot be reached. */
  warn?: (message: string) => void;
  timeoutMs?: number;
  hostname?: () => string;
}

const REQUEST_TIMEOUT_MS = 8000;

/** The view fields a record does not carry; dropped when a view is read back as one. */
const VIEW_ONLY_FIELDS = [
  'status',
  'hostIsHub',
  'resumable',
  'resumeBlockedBy',
  'attachCommand',
  'background',
  'terminalSession',
  'workspaceName',
  'taskCounts',
] as const;

function recordOf(view: ManagerView): ManagerRecord {
  const rec = { ...view } as Record<string, unknown>;
  for (const field of VIEW_ONLY_FIELDS) delete rec[field];
  return rec as unknown as ManagerRecord;
}

export function remoteManagerStore(
  target: ControlBoxTarget,
  opts: RemoteManagerStoreOptions = {},
): ManagerRecordStore {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const base = target.url.replace(/\/+$/, '');
  let warned = false;

  function warnOnce(err: unknown): void {
    if (warned) return;
    warned = true;
    opts.warn?.(
      `[manager] could not reach the control box at ${base}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetchImpl(`${base}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${target.apiKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** `undefined` on any transport or status failure: a read never throws here. */
  async function get<T>(path: string): Promise<T | undefined> {
    try {
      const res = await call('GET', path);
      if (!res.ok) return undefined;
      return (await res.json()) as T;
    } catch (err) {
      warnOnce(err);
      return undefined;
    }
  }

  async function views(path: string): Promise<ManagerView[]> {
    return (await get<{ managers?: ManagerView[] }>(path))?.managers ?? [];
  }

  return {
    kind: 'remote',
    async listManagers() {
      return (await views('/managers')).map(recordOf);
    },
    async readManagers(wsId) {
      return (await views(`/workspaces/${encodeURIComponent(wsId)}/managers`)).map(recordOf);
    },
    async readWorkspace(wsId) {
      return (await get<ManagerWorkspace>(`/workspaces/${encodeURIComponent(wsId)}`)) ?? null;
    },
    async findManager(id) {
      const view = await get<ManagerView>(`/managers/${encodeURIComponent(id)}`);
      return view ? recordOf(view) : null;
    },
    async findManagerBySession(agent, sessionId) {
      const hit = (await views('/managers')).find(
        (m) => m.agent === agent && m.sessionId === sessionId,
      );
      return hit ? recordOf(hit) : null;
    },
    async registerManager(wsId, input) {
      try {
        const res = await call(
          'POST',
          `/workspaces/${encodeURIComponent(wsId)}/managers/register`,
          input,
        );
        if (!res.ok) throw new Error(`register failed: ${String(res.status)}`);
        return recordOf((await res.json()) as ManagerView);
      } catch (err) {
        warnOnce(err);
        throw err;
      }
    },
    async reportManager(id, beat) {
      try {
        await call('POST', `/managers/${encodeURIComponent(id)}/heartbeat`, beat);
      } catch (err) {
        // A missed heartbeat is not a failure of the thing that triggered it:
        // the record simply ages out of the last-seen window.
        warnOnce(err);
      }
    },
    async attachBox(_wsId, id, target) {
      try {
        const res = await call('POST', `/managers/${encodeURIComponent(id)}/attach-box`, target);
        if (!res.ok) throw new Error(`attach-box failed: ${String(res.status)}`);
      } catch (err) {
        // Bookkeeping: the task to box join the UI reads goes through the task
        // store, so a miss costs the manager's own box list and nothing else.
        warnOnce(err);
      }
    },
    // A record held elsewhere is only ever written by a registration, a
    // heartbeat or a box attach; a control box refuses anything else from
    // another host.
    patchManager: async () => null,
    upsertDetectedManager() {
      return Promise.reject(
        new Error('a manager is detected on the hub that holds the workspace, not here'),
      );
    },
    removeManagerRecord: async () => false,
    async managerViews(filter) {
      return filter?.workspaceId
        ? views(`/workspaces/${encodeURIComponent(filter.workspaceId)}/managers`)
        : views('/managers');
    },
    managerView(id) {
      return get<ManagerView>(`/managers/${encodeURIComponent(id)}`).then((v) => v ?? null);
    },
  };
}

let current: ManagerRecordStore = fileManagerStore();

/** The store this process persists manager records through. */
export function managerStore(): ManagerRecordStore {
  return current;
}

/** Install a store (`null` restores the file one). Returns what is now installed. */
export function configureManagerStore(store: ManagerRecordStore | null): ManagerRecordStore {
  current = store ?? fileManagerStore();
  return current;
}

/**
 * Pick the store from this machine's config, by the same rule as the timeline
 * sink: the control box when one is configured and this process is not one
 * itself, else this disk.
 */
export async function configureManagerStoreFromConfig(
  opts: RemoteManagerStoreOptions = {},
): Promise<ManagerRecordStore> {
  const target = await resolveControlBox();
  return configureManagerStore(target ? remoteManagerStore(target, opts) : null);
}
