// The manager domain: host agent sessions that orchestrate boxes, many per
// workspace. A manager is either `external` (a claude/codex session in the
// user's own terminal, registered when the CLI runs inside it) or `hub` (one
// this hub started in tmux). State lives in @agentbox/relay's workspace store.
import { homedir, hostname as osHostname } from 'node:os';
import {
  addWorkspace,
  attachBackgroundSession,
  attachBoxToManager,
  backgroundFor,
  buildManagerArgv,
  canonicalWorkspaceRoot,
  createBackgroundSessionLookup,
  detachBackgroundSession,
  findManager,
  findManagerBySession,
  findWorkspaceContaining,
  isResumableManagerAgent,
  listResumableHostSessions,
  listTmuxSessions,
  listWorkspaces,
  liveBackgroundSession,
  MANAGER_SESSION_RE,
  managerSessionName,
  managerStatus,
  newManagerId,
  patchManager,
  processStartTime,
  readManagerExit,
  readManagers,
  readReconciledManagers,
  readTasks,
  readTimeline,
  readWorkspace,
  timelineSink,
  removeManagerRecord,
  resumeManagerSession,
  sendKeysToManager,
  sessionTitle,
  sessionTurn,
  stampFields,
  startManagerSession,
  stopManagerSession,
  terminalSessionFor,
  tmuxAvailable,
  toManagerView,
  UNTITLED_SESSION,
  upsertDetectedManager,
  usesLegacySession,
  workspaceRootOn,
  RESUMABLE_MANAGER_AGENTS,
  type BackgroundSessionLookup,
  type BackgroundSession,
  type BackgroundSessionSnapshot,
  type ManagerProbe,
  type ManagerRecord,
  type ReconcileContext,
  type TimelineEvent,
  type TimelineEventType,
  type TimelinePr,
  type TimelineStamp,
  type WorkspaceRecord,
} from '@agentbox/relay';
import { reconcileContext, type BackendDeps } from './deps';
import { stampInWorkspace } from './timeline';
import { TMUX_MISSING } from './errors';
import type {
  ActionResult,
  DetectManagerInput,
  DetectManagerResult,
  ManagerBackend,
  ManagerFilter,
  ManagerMessageDelivery,
  ManagerMessageResult,
  ManagerNoteResult,
  ManagerResult,
  ManagerSessionsResult,
  StartManagerInput,
  TimelineMeta,
  TimelineSessionRef,
} from '../boxes/backend-types';
import type { ManagerView, WorkspaceView } from '../boxes/types';

function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

/** A refusal about the request itself: the route answers 400, not 409. */
function invalid(message: string): { ok: false; error: string; invalid: true } {
  return { ok: false, error: message, invalid: true };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ManagerBackendOptions {
  /** The workspace slice's view, so a detect answers with the same shape `GET /workspaces` does. */
  workspaceView(id: string): Promise<WorkspaceView | null>;
  /** Seams for the title lookup and its retry clock; production reads the agent's store. */
  sessionTitle?: typeof sessionTitle;
  now?: () => number;
  /** Seam for the turn lookup that stamps timeline events. */
  sessionTurn?: typeof sessionTurn;
  /** The pause between typing a message and submitting it; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Seam for Claude's background sessions; production reads `claude agents` through `managerExec`. */
  claudeBackground?: BackgroundSessionLookup;
}

/** What a stop answers for a manager whose session lives in Claude's daemon. */
export const BACKGROUND_STOP_NOTICE =
  "The Claude session keeps running in Claude's background daemon; only this hub's terminal for it was closed. End the session itself with `claude stop <id>`.";

/**
 * How long a session whose title could not be read is left alone. `GET /managers`
 * is polled, and a codex lookup can scan hundreds of rollout files.
 */
const TITLE_RETRY_MS = 10 * 60 * 1000;

export function createManagerBackend(
  deps: BackendDeps,
  opts: ManagerBackendOptions,
): ManagerBackend {
  const hostname = deps.hostname ?? osHostname;
  const probe: ManagerProbe = {
    hostname,
    ...(deps.managerExec ? { exec: deps.managerExec } : {}),
    ...(deps.isPidAlive ? { isPidAlive: deps.isPidAlive } : {}),
    ...(deps.processStartTime ? { processStartTime: deps.processStartTime } : {}),
  };

  /**
   * The agent's store is only on the machine the session ran on: a hub-run
   * manager is always here, an external one only when it reported this host.
   */
  function storeIsLocal(rec: ManagerRecord): boolean {
    return rec.kind === 'hub' || rec.host === hostname();
  }

  const lookupTitle = opts.sessionTitle ?? sessionTitle;
  const now = opts.now ?? Date.now;
  /** Failed lookups by manager id, in memory only: a miss is not a fact to persist. */
  const titleMisses = new Map<string, { sessionId: string; at: number }>();

  /**
   * Cache the session's title on the record the first time a real one can be
   * read. An untitled answer is not cached — the session may simply not have a
   * first turn yet — and a miss is retried only after `TITLE_RETRY_MS`.
   */
  async function withTitle(raw: ManagerRecord): Promise<ManagerRecord> {
    let rec = raw;
    if (rec.title === UNTITLED_SESSION) {
      // Written by an earlier build that cached it.
      rec = { ...raw };
      delete rec.title;
    }
    if (rec.title || !rec.sessionId || !storeIsLocal(rec)) return rec;
    const sessionId = rec.sessionId;
    const miss = titleMisses.get(rec.id);
    if (miss && miss.sessionId === sessionId && now() - miss.at < TITLE_RETRY_MS) return rec;
    const title = await lookupTitle(rec.agent, rec.cwd, sessionId).catch(() => null);
    if (!title || title === UNTITLED_SESSION) {
      titleMisses.set(rec.id, { sessionId, at: now() });
      return rec;
    }
    titleMisses.delete(rec.id);
    // Guarded on the session id: a detect that moved the record to a new session
    // meanwhile must not get the old session's title written over it.
    await patchManager(rec.workspaceId, rec.id, (cur) =>
      cur.sessionId === sessionId && (!cur.title || cur.title === UNTITLED_SESSION)
        ? { ...cur, title }
        : cur,
    ).catch(() => null);
    return { ...rec, title };
  }

  const lookupBackground =
    opts.claudeBackground ??
    createBackgroundSessionLookup(deps.managerExec ? { exec: deps.managerExec } : {});

  /** The live daemon session a claude manager's session id names; only for a session on this machine. */
  async function daemonSession(
    rec: ManagerRecord,
    fresh = false,
  ): Promise<BackgroundSession | undefined> {
    if (rec.agent !== 'claude' || !rec.sessionId || !storeIsLocal(rec)) return undefined;
    return liveBackgroundSession(rec, await lookupBackground({ fresh }));
  }

  /** Running by its process, or by a session Claude's daemon still hosts. */
  async function effectiveStatus(rec: ManagerRecord): Promise<'running' | 'stopped'> {
    if (await daemonSession(rec)) return 'running';
    return managerStatus(rec, probe);
  }

  function backgroundResumeRefusal(rec: ManagerRecord, s: BackgroundSession): string {
    return `manager ${rec.id} is still running as a Claude background session (${s.id}); attach to it instead of resuming it`;
  }

  const lookupTurn = opts.sessionTurn ?? sessionTurn;

  /**
   * A manager as a timeline actor, with its current turn.
   *
   * The transcript is the truth when it is HERE. When it is not — the manager
   * runs on a PC and this is its control box — the only reader is that PC, so
   * the turn it reported with the call is used instead. `reported` is
   * client-asserted, hence never preferred over a transcript this hub can read.
   */
  async function managerStamp(
    rec: ManagerRecord,
    reported?: { turn?: number; prompt?: string },
  ): Promise<TimelineStamp> {
    const local = storeIsLocal(rec);
    const turn =
      rec.sessionId && local
        ? await lookupTurn(rec.agent, rec.cwd, rec.sessionId).catch(() => undefined)
        : !local && reported?.turn !== undefined
          ? { turn: reported.turn, ...(reported.prompt ? { prompt: reported.prompt } : {}) }
          : undefined;
    return {
      actor: 'manager',
      managerId: rec.id,
      ...(turn ? { turn: turn.turn, ...(turn.prompt ? { prompt: turn.prompt } : {}) } : {}),
    };
  }

  async function timelineStamp(
    ref: TimelineSessionRef | { managerId: string },
    wsId?: string,
  ): Promise<TimelineStamp | undefined> {
    const rec =
      'managerId' in ref
        ? await findManager(ref.managerId)
        : await findManagerBySession(ref.agent, ref.sessionId);
    if (!rec || (wsId !== undefined && rec.workspaceId !== wsId)) return undefined;
    return managerStamp(rec, 'managerId' in ref ? undefined : ref);
  }

  /** A lifecycle event about `rec`, by whoever the meta names in its workspace. Best-effort. */
  async function recordManagerEvent(
    rec: ManagerRecord,
    type: TimelineEventType,
    meta: TimelineMeta | undefined,
  ): Promise<void> {
    await timelineSink().record(rec.workspaceId, {
      type,
      ...stampFields(await stampInWorkspace(meta, rec.workspaceId, timelineStamp)),
      managerId: rec.id,
      agent: rec.agent,
    });
  }

  /**
   * The PR a message is about, as the log last saw it. Without `repo` that is
   * the one repo in the log with this number; with none or several, the repo
   * stays unknown, and an unknown repo matches no PR on read.
   */
  async function knownPr(wsId: string, number: number, repo?: string): Promise<TimelinePr> {
    const hits = (await readTimeline(wsId).catch((): TimelineEvent[] => [])).filter(
      (ev) => ev.pr?.number === number && ev.pr.repo && (!repo || ev.pr.repo === repo),
    );
    const last = hits.at(-1)?.pr;
    if (last && new Set(hits.map((ev) => ev.pr!.repo)).size === 1) return last;
    return { repo: repo ?? '', number, title: '', url: '', base: '', head: '' };
  }

  async function viewsOf(ws: WorkspaceRecord, ctx: ReconcileContext): Promise<ManagerView[]> {
    const records = await readReconciledManagers(ws.id, ctx);
    if (records.length === 0) return [];
    const tasks = await readTasks(ws.id);
    // Only a claude session on this machine can be in Claude's daemon or in a
    // tmux session here; a workspace without one never pays for the lookup.
    const snap: BackgroundSessionSnapshot | undefined = records.some(
      (r) => r.agent === 'claude' && storeIsLocal(r),
    )
      ? await lookupBackground()
      : undefined;
    const claimed = new Set<string>();
    for (const r of records) {
      claimed.add(managerSessionName(r.id));
      if (r.tmuxSession) claimed.add(r.tmuxSession);
    }
    return Promise.all(
      records.map(async (raw) => {
        const rec = await withTitle(raw);
        const local = snap !== undefined && rec.agent === 'claude' && storeIsLocal(rec);
        const background = local ? backgroundFor(rec, snap) : undefined;
        const inDaemon = local ? liveBackgroundSession(rec, snap) : undefined;
        const status = background || inDaemon ? 'running' : await managerStatus(rec, probe);
        const own = managerSessionName(rec.id);
        const attachSession =
          background && snap?.managerTmux.some((t) => t.session === own) ? own : null;
        const terminalSession =
          local && snap && rec.kind === 'external' && status === 'running'
            ? terminalSessionFor(rec, snap, claimed)
            : undefined;
        const lastExit =
          status === 'stopped' && rec.kind === 'hub' && rec.lastExit === undefined
            ? await readManagerExit(ws.id, rec.id, { legacy: usesLegacySession(rec) })
            : undefined;
        return toManagerView(rec, {
          status,
          hostname: hostname(),
          workspaceName: ws.name,
          tasks,
          ...(background ? { background, attachSession } : {}),
          ...(terminalSession ? { terminalSession } : {}),
          ...(lastExit === undefined ? {} : { lastExit }),
        });
      }),
    );
  }

  async function viewOf(id: string): Promise<ManagerView | null> {
    const rec = await findManager(id);
    if (!rec) return null;
    const ws = await readWorkspace(rec.workspaceId);
    if (!ws) return null;
    return (await viewsOf(ws, await reconcileContext(deps))).find((m) => m.id === id) ?? null;
  }

  /**
   * Why a detect must not create a workspace at `cwd`, or null. A session run
   * from `/` or the home folder would otherwise claim every project under it,
   * and a caller's path that is not a folder here would register a phantom.
   */
  async function autoWorkspaceRefusal(cwd: string, callerHome?: string): Promise<string | null> {
    // The caller's home when it sent one: the folder is on ITS machine, and this
    // hub's own `$HOME` says nothing about a session running elsewhere. The
    // folder itself is never stat'd here for the same reason.
    const home = callerHome
      ? callerHome.replace(/\/+$/, '')
      : await canonicalWorkspaceRoot(homedir());
    const what =
      cwd === '/'
        ? 'is the filesystem root'
        : cwd === home
          ? 'is your home folder'
          : home.startsWith(`${cwd}/`)
            ? 'contains your home folder'
            : null;
    if (what) {
      return `not creating a workspace at ${cwd}: it ${what}. Register the project folder instead: agentbox workspace add <project folder>`;
    }
    return null;
  }

  /**
   * The migrated single-manager record a detect with no `managerId` comes from.
   * That layout started its agent with `AGENTBOX_MANAGER=1`, which names no
   * record, so its first detect would otherwise register a duplicate external
   * manager beside the running hub one. Limited to records still on the old tmux
   * name: a current hub-run manager exports its own id, and a terminal session in
   * the same folder must not be folded into it.
   */
  async function legacyManagerFor(
    wsId: string,
    agent: string,
    cwd: string,
  ): Promise<string | undefined> {
    const candidates = (await readManagers(wsId)).filter(
      (m) => usesLegacySession(m) && !m.sessionId && m.agent === agent && m.cwd === cwd,
    );
    const running: string[] = [];
    for (const m of candidates) {
      if ((await managerStatus(m, probe)) === 'running') running.push(m.id);
    }
    return running.length === 1 ? running[0] : undefined;
  }

  /**
   * The record a detect's `managerId` hint names, when it can be believed. Claude's
   * daemon hands the env of the client that spawned it to every session it hosts,
   * so `$AGENTBOX_MANAGER` reaches sessions that have nothing to do with that
   * manager. Believed only for a record in the same folder that has no session
   * yet (a hub start whose agent reports for the first time) or that is hub-run
   * and running (its agent after a `/clear`).
   */
  async function trustedHint(
    managerId: string | undefined,
    cwd: string,
  ): Promise<ManagerRecord | undefined> {
    if (!managerId) return undefined;
    const rec = await findManager(managerId);
    if (!rec || rec.cwd !== cwd) return undefined;
    if (!rec.sessionId) return rec;
    if (rec.kind === 'hub' && (await managerStatus(rec, probe)) === 'running') return rec;
    return undefined;
  }

  async function findManagerByTmux(session: string): Promise<ManagerRecord | undefined> {
    for (const ws of await listWorkspaces()) {
      const hit = (await readManagers(ws.id)).find((m) => m.tmuxSession === session);
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * The AgentBox tmux session a detect says it runs in, when it exists on this
   * machine and started in the detect's folder: the manager that owns it, or the
   * session itself to adopt when none does (the single-manager layout's
   * `agentbox-manager-<workspaceId>`, whose migrated record was never written).
   */
  async function tmuxHome(
    input: DetectManagerInput,
    cwd: string,
  ): Promise<{ owner?: ManagerRecord; adopt?: string } | undefined> {
    const name = input.tmuxSession;
    if (!name || !MANAGER_SESSION_RE.test(name) || input.host !== hostname()) return undefined;
    const found = (await listTmuxSessions(deps.managerExec)).find((t) => t.session === name);
    if (!found) return undefined;
    const path = await canonicalWorkspaceRoot(found.path).catch(() => found.path);
    if (path !== cwd) return undefined;
    const owner =
      (await findManager(name.slice('agentbox-manager-'.length))) ??
      (await findManagerByTmux(name));
    if (owner) return owner.cwd === cwd ? { owner } : undefined;
    return { adopt: name };
  }

  /** Running first, then the most recently seen. */
  function sortViews(views: ManagerView[]): ManagerView[] {
    return [...views].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
      return b.lastSeenAt.localeCompare(a.lastSeenAt);
    });
  }

  async function answer(id: string): Promise<ManagerResult> {
    const view = await viewOf(id);
    return view ? { ok: true, manager: view } : err(`unknown manager ${id}`);
  }

  return {
    async detectManager(input: DetectManagerInput): Promise<DetectManagerResult> {
      const cwd = await canonicalWorkspaceRoot(input.cwd);
      const home = await tmuxHome(input, cwd);
      const hinted = home?.owner ?? (await trustedHint(input.managerId, cwd));
      // A session already registered stays where it is, even when this call came
      // from a subfolder another workspace contains.
      const known = (await findManagerBySession(input.agent, input.sessionId)) ?? hinted ?? null;
      let ws = known ? await readWorkspace(known.workspaceId) : null;
      let workspaceCreated = false;
      if (!ws) {
        ws = findWorkspaceContaining(await listWorkspaces(), cwd, input.host ?? hostname());
        if (!ws) {
          const refusal = await autoWorkspaceRefusal(cwd, input.home);
          if (refusal) return invalid(refusal);
          try {
            ws = await addWorkspace({
              host: input.host ?? hostname(),
              root: cwd,
              projects: input.projects ?? [],
            });
            workspaceCreated = true;
          } catch (e) {
            return err(`could not register a workspace at ${cwd}: ${messageOf(e)}`);
          }
        }
      }
      // Only a pid from this machine can be stamped: elsewhere it names another process.
      const pidStartedAt =
        input.pid !== undefined && input.host === hostname()
          ? await (deps.processStartTime ?? processStartTime)(input.pid).catch(() => undefined)
          : undefined;
      const managerId =
        hinted?.id ?? (known ? undefined : await legacyManagerFor(ws.id, input.agent, cwd));
      const { manager, created, sessionChanged } = await upsertDetectedManager(ws.id, {
        agent: input.agent,
        sessionId: input.sessionId,
        cwd,
        ...(input.pid !== undefined ? { pid: input.pid } : {}),
        ...(pidStartedAt ? { pidStartedAt } : {}),
        ...(input.host ? { host: input.host } : {}),
        ...(managerId ? { managerId } : {}),
        ...(input.tmuxPane ? { tmuxPane: input.tmuxPane } : {}),
        ...(home?.adopt ? { tmuxSession: home.adopt } : {}),
      });
      if (input.boxId) await attachBoxToManager(ws.id, manager.id, { boxId: input.boxId });
      else if (input.boxJobId) {
        await attachBoxToManager(ws.id, manager.id, { boxJobId: input.boxJobId });
      }
      // A detect runs on nearly every CLI call; only a new record or a new
      // session in an existing one (`/clear`, a hub-run agent's first call) is news.
      if (created || sessionChanged) {
        await recordManagerEvent(manager, 'manager.joined', { stamp: { actor: 'manager' } });
      }
      deps.notify();
      const [view, workspace] = await Promise.all([viewOf(manager.id), opts.workspaceView(ws.id)]);
      if (!view || !workspace) return err('the manager was not written');
      return { ok: true, manager: view, workspace, created: created || workspaceCreated };
    },

    async listManagers(filter?: ManagerFilter): Promise<ManagerView[]> {
      const all = await listWorkspaces();
      const wanted = filter?.workspaceId ? all.filter((w) => w.id === filter.workspaceId) : all;
      if (wanted.length === 0) return [];
      const ctx = await reconcileContext(deps);
      const views = (await Promise.all(wanted.map((ws) => viewsOf(ws, ctx)))).flat();
      return sortViews(filter?.status ? views.filter((v) => v.status === filter.status) : views);
    },

    getManager: viewOf,

    async listWorkspaceManagers(wsId: string): Promise<ManagerView[] | null> {
      const ws = await readWorkspace(wsId);
      if (!ws) return null;
      return sortViews(await viewsOf(ws, await reconcileContext(deps)));
    },

    async startManager(
      wsId: string,
      input: StartManagerInput,
      meta?: TimelineMeta,
    ): Promise<ManagerResult> {
      const ws = await readWorkspace(wsId);
      if (!ws) return err(`unknown workspace ${wsId}`);
      if (!(await tmuxAvailable(deps.managerExec))) return err(TMUX_MISSING);
      // The route validator is the accept-list for `agent`; here we only need the
      // one rule it cannot express — only some agents can be resumed, and
      // starting a FRESH agent that looks resumed is worse than a 400.
      if (input.sessionId && !isResumableManagerAgent(input.agent)) {
        return err(
          `session resume is only supported for ${RESUMABLE_MANAGER_AGENTS.join(', ')}, not ${input.agent}`,
        );
      }
      if (input.sessionId) {
        // A session some manager already holds is resumed AS that manager, so the
        // boxes and tasks it collected stay with it instead of forking a duplicate.
        const existing = await findManagerBySession(input.agent, input.sessionId);
        if (existing) {
          const inDaemon = await daemonSession(existing, true);
          if (inDaemon) return err(backgroundResumeRefusal(existing, inDaemon));
          try {
            if (
              input.restart &&
              existing.kind === 'hub' &&
              (await managerStatus(existing, probe)) === 'running'
            ) {
              await stopManagerSession(existing.workspaceId, existing.id, probe);
            }
            await resumeManagerSession(existing.workspaceId, existing.id, probe);
          } catch (e) {
            return err(messageOf(e));
          }
          await recordManagerEvent(existing, 'manager.resumed', meta);
          deps.notify();
          return answer(existing.id);
        }
      }
      // A manager is a process in the folder, so it can only start where the
      // folder is. A workspace registered from another machine has none here.
      const root = workspaceRootOn(ws, hostname());
      if (!root) {
        return err(
          `workspace ${ws.name} has no folder on ${hostname()}; start its manager on the machine that has one`,
        );
      }
      const at = new Date().toISOString();
      const manager: ManagerRecord = {
        id: newManagerId(),
        workspaceId: ws.id,
        agent: input.agent,
        kind: 'hub',
        cwd: root,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        boxIds: [],
        boxJobIds: [],
        createdAt: at,
        lastSeenAt: at,
      };
      try {
        await startManagerSession({
          wsId: ws.id,
          manager,
          argv: buildManagerArgv(input.agent, input.sessionId),
          ...(deps.managerExec ? { exec: deps.managerExec } : {}),
        });
      } catch (e) {
        return err(`could not start the manager: ${messageOf(e)}`);
      }
      await recordManagerEvent(manager, 'manager.started', meta);
      deps.notify();
      return answer(manager.id);
    },

    async resumeManager(id: string, meta?: TimelineMeta): Promise<ManagerResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      const inDaemon = await daemonSession(rec, true);
      if (inDaemon) return err(backgroundResumeRefusal(rec, inDaemon));
      if (!(await tmuxAvailable(deps.managerExec))) return err(TMUX_MISSING);
      try {
        await resumeManagerSession(rec.workspaceId, id, probe);
      } catch (e) {
        return err(messageOf(e));
      }
      await recordManagerEvent(rec, 'manager.resumed', meta);
      deps.notify();
      return answer(id);
    },

    async attachManager(id: string): Promise<ManagerResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      const snap =
        rec.agent === 'claude' && storeIsLocal(rec)
          ? await lookupBackground({ fresh: true })
          : undefined;
      const background = snap ? backgroundFor(rec, snap) : undefined;
      if (!background) {
        return err(
          snap && liveBackgroundSession(rec, snap)
            ? `manager ${id}'s Claude session may already be open in a terminal (an AgentBox tmux session in its folder, or a claude attach client); the hub attaches only to a session nothing shows`
            : `manager ${id} has no running Claude background session to attach to`,
        );
      }
      if (!(await tmuxAvailable(deps.managerExec))) return err(TMUX_MISSING);
      try {
        await attachBackgroundSession({
          wsId: rec.workspaceId,
          manager: rec,
          backgroundId: background.id,
          ...(deps.managerExec ? { exec: deps.managerExec } : {}),
        });
      } catch (e) {
        return err(`could not attach: ${messageOf(e)}`);
      }
      // The snapshot predates the session just started; the answer must show it.
      await lookupBackground({ fresh: true });
      deps.notify();
      return answer(id);
    },

    async stopManager(id: string, meta?: TimelineMeta): Promise<ManagerResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      const inDaemon = await daemonSession(rec, true);
      if (inDaemon && rec.kind === 'external') {
        // Its session is Claude's daemon's, not the hub's: only the attach client goes.
        await detachBackgroundSession(rec.workspaceId, id, deps.managerExec);
        await lookupBackground({ fresh: true });
        deps.notify();
        const view = await viewOf(id);
        return view
          ? { ok: true, manager: view, notice: BACKGROUND_STOP_NOTICE }
          : err(`unknown manager ${id}`);
      }
      const wasRunning = (await managerStatus(rec, probe)) === 'running';
      try {
        await stopManagerSession(rec.workspaceId, id, probe);
      } catch (e) {
        return err(messageOf(e));
      }
      // Stop is idempotent: stopping a session that had already ended is not an event.
      if (wasRunning) await recordManagerEvent(rec, 'manager.stopped', meta);
      deps.notify();
      const stopped = await answer(id);
      return stopped.ok && inDaemon ? { ...stopped, notice: BACKGROUND_STOP_NOTICE } : stopped;
    },

    async removeManager(id: string, opts: { force?: boolean } = {}): Promise<ActionResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      // A record is the only handle on a running process: forgetting it would
      // leave a tmux session (or a terminal session's boxes) nothing points at.
      // `force` is the way out when the status is wrong (a pid the probe cannot
      // tell apart, a last-seen window that has not lapsed yet).
      if (!opts.force && (await effectiveStatus(rec)) === 'running') {
        return err(`manager ${id} is running; stop it before forgetting it (or force it)`);
      }
      await removeManagerRecord(rec.workspaceId, id);
      deps.notify();
      return { ok: true };
    },

    async listManagerSessions(wsId: string, agent?: string): Promise<ManagerSessionsResult | null> {
      const ws = await readWorkspace(wsId);
      if (!ws) return null;
      // The agent's sessions are files in the folder's own store: nothing to
      // list for a workspace whose folder is on another machine.
      const root = workspaceRootOn(ws, hostname());
      if (!root) return { agent: agent ?? 'claude', supported: true, sessions: [] };
      return listResumableHostSessions(root, agent ?? 'claude');
    },

    timelineStamp,

    async addManagerNote(id, input): Promise<ManagerNoteResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      const event = await timelineSink().record(rec.workspaceId, {
        type: 'manager.note',
        ...stampFields(await managerStamp(rec)),
        text: input.text,
        noteKind: input.kind ?? 'note',
      });
      // Here the log write IS the mutation, so unlike every other writer a miss is an error.
      if (!event) return err(`the note for manager ${id} was not recorded`);
      deps.notify();
      return { ok: true, event };
    },

    async sendManagerMessage(id, input, meta): Promise<ManagerMessageResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      const status = await managerStatus(rec, probe);
      let delivered: ManagerMessageDelivery;
      try {
        if (status === 'running' && rec.kind === 'hub') {
          await sendKeysToManager(
            { session: rec.tmuxSession ?? managerSessionName(rec.id) },
            input.text,
            deps.managerExec,
            opts.sleep,
          );
          delivered = 'session';
        } else if (status === 'running') {
          // A pane is only reachable on the machine whose tmux server holds it.
          if (!rec.tmuxPane || !storeIsLocal(rec)) {
            return {
              ok: false,
              code: 'manager_unreachable',
              error: `manager ${id} runs in your terminal${rec.tmuxPane ? ' on another machine' : ' outside tmux'}, where the hub cannot type; paste the message into that session`,
            };
          }
          await sendKeysToManager({ pane: rec.tmuxPane }, input.text, deps.managerExec, opts.sleep);
          delivered = 'pane';
        } else {
          if (!(await tmuxAvailable(deps.managerExec))) return err(TMUX_MISSING);
          await resumeManagerSession(rec.workspaceId, id, probe, { prompt: input.text });
          delivered = 'resumed';
        }
      } catch (e) {
        return err(messageOf(e));
      }
      const [pr, stamp] = await Promise.all([
        input.prNumber !== undefined
          ? knownPr(rec.workspaceId, input.prNumber, input.repo)
          : undefined,
        stampInWorkspace(meta, rec.workspaceId, timelineStamp),
      ]);
      const event = await timelineSink().record(rec.workspaceId, {
        type: 'manager.message',
        ...stampFields(stamp),
        managerId: rec.id,
        text: input.text,
        ...(pr ? { pr } : {}),
      });
      deps.notify();
      const view = await viewOf(id);
      if (!view) return err(`unknown manager ${id}`);
      return { ok: true, delivered, manager: view, event };
    },

    async attachJob(managerId: string, jobId: string): Promise<ActionResult> {
      const rec = await findManager(managerId);
      if (!rec) return err(`unknown manager ${managerId}`);
      await attachBoxToManager(rec.workspaceId, managerId, { boxJobId: jobId });
      deps.notify();
      return { ok: true };
    },

    async managerByBox(): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      const all = await listWorkspaces();
      if (all.length === 0) return out;
      const ctx = await reconcileContext(deps);
      for (const ws of all) {
        for (const m of await readReconciledManagers(ws.id, ctx)) {
          for (const boxId of m.boxIds) out.set(boxId, m.id);
          for (const jobId of m.boxJobIds) out.set(jobId, m.id);
        }
      }
      return out;
    },
  };
}
