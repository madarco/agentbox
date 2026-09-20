// The manager domain: host agent sessions that orchestrate boxes, many per
// workspace. A manager is either `external` (a claude/codex session in the
// user's own terminal, registered when the CLI runs inside it) or `tmux` (one a
// hub started in a tmux session on its own machine).
//
// A manager RUNS on one machine and its record is STORED on another whenever a
// control box is configured: the folder, the tmux server and the transcript are
// on the user's PC, while the workspace that owns the record is on the box. Two
// rules follow, and everything here is one of them:
//   - a process op (start/resume/attach/stop/sessions/type) is refused unless
//     `rec.host` is this machine — `wrong_host`, with the host to retry against;
//   - a record this hub does not host is shown from its last heartbeat.
import { homedir, hostname as osHostname } from 'node:os';
import {
  addWorkspace,
  attachBackgroundSession,
  backgroundFor,
  buildManagerArgv,
  canonicalWorkspaceRoot,
  createBackgroundSessionLookup,
  detachBackgroundSession,
  findWorkspaceContaining,
  freshHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  isResumableManagerAgent,
  listResumableHostSessions,
  listTmuxSessions,
  listWorkspaces,
  liveBackgroundSession,
  MANAGER_SEEN_WINDOW_MS,
  managerSessionName,
  managerStatus,
  managerStore,
  MANAGER_SESSION_RE,
  newManagerId,
  processStartTime,
  readManagerExit,
  readTasks,
  readTimeline,
  reconcileManagers,
  timelineSink,
  resumeManagerSession,
  ptyAttachFor,
  ptyConfigure,
  resolvePtyHostEntry,
  ptyInject,
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
  workspaceRootOn,
  RESUMABLE_MANAGER_AGENTS,
  type BackgroundSessionLookup,
  type BackgroundSession,
  type BackgroundSessionSnapshot,
  type ManagerHeartbeat,
  type ManagerProbe,
  type ManagerBoxTarget,
  type ManagerRecord,
  type ManagerRecordStore,
  type ManagerWorkspace,
  type ManagerCarrier,
  type ManagerPtyAttach,
  type PtyCarrierSettings,
  type SpawnPtyHost,
  type ManagerRegistration,
  type ReconcileContext,
  type TimelineEvent,
  type TimelineEventType,
  type TimelinePr,
  type TimelineStamp,
  type WorkTask,
} from '@agentbox/relay';
import { loadEffectiveConfig } from '@agentbox/config';
import { PTY_PROTOCOL_VERSION } from '@agentbox/core';
import { readPtyMeta } from '@agentbox/sandbox-core';
import { reconcileContext, type BackendDeps } from './deps';
import { stampInWorkspace } from './timeline';
import { MANAGER_CARRIER_MISSING, PTY_CARRIER_MISSING, TMUX_MISSING } from './errors';
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
  ManagerSessionsAnswer,
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

/**
 * "That manager does not run here." The client retries against the hub on
 * `host` — its own local hub, when `host` is its own hostname.
 *
 * `hosts` is for the refusals that name a WORKSPACE's machines rather than one
 * manager's: a workspace mapped from two PCs has no single right answer, and
 * naming an arbitrary one would make every other caller's "is that me?" test
 * fail and skip the retry. `host` stays the first of them so a client that only
 * reads it is no worse off than before.
 */
function wrongHost(
  message: string,
  host: string,
  hosts?: string[],
): {
  ok: false;
  error: string;
  code: 'wrong_host';
  details: { host: string; hosts?: string[] };
} {
  return {
    ok: false,
    error: message,
    code: 'wrong_host',
    details: { host, ...(hosts && hosts.length > 1 ? { hosts } : {}) },
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ManagerBackendOptions {
  /** The workspace slice's view, so a detect answers with the same shape `GET /workspaces` does. */
  workspaceView(id: string): Promise<WorkspaceView | null>;
  /**
   * Where manager records are persisted: this disk, or the control box that owns
   * the workspace. Defaults to the process-wide store
   * (`configureManagerStoreFromConfig`).
   */
  store?: ManagerRecordStore;
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

// The heartbeat model lives with the record shape, in @agentbox/relay: a status
// derived from a report is what `managerStatus` answers for a foreign record, so
// the window cannot be this slice's private business.
export { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS };

export function createManagerBackend(
  deps: BackendDeps,
  opts: ManagerBackendOptions,
): ManagerBackend {
  const hostname = deps.hostname ?? osHostname;
  const store = opts.store ?? managerStore();
  const probe: ManagerProbe = {
    hostname,
    ...(deps.managerExec ? { exec: deps.managerExec } : {}),
    ...(deps.isPidAlive ? { isPidAlive: deps.isPidAlive } : {}),
    ...(deps.processStartTime ? { processStartTime: deps.processStartTime } : {}),
  };

  /**
   * Whether this hub is the machine the manager runs on. Everything that reads
   * the session — its process, its tmux server, its transcript, Claude's daemon
   * — is only true there, and everything that drives it is refused elsewhere.
   */
  function storeIsLocal(rec: ManagerRecord): boolean {
    return rec.host === hostname();
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
    // meanwhile must not get the old session's title written over it. Only the
    // store that HOLDS the record can check that, so a remote one learns the
    // title from the heartbeat instead.
    if (store.kind === 'file') {
      await store.patchManager(rec.workspaceId, rec.id, { title }).catch(() => null);
    }
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

  /** The last heartbeat, while it is fresh enough to believe. */
  function freshReport(rec: ManagerRecord): ManagerHeartbeat | undefined {
    return freshHeartbeat(rec, now());
  }

  function backgroundResumeRefusal(rec: ManagerRecord, s: BackgroundSession): string {
    return `manager ${rec.id} is still running as a Claude background session (${s.id}); attach to it instead of resuming it`;
  }

  function elsewhere(rec: ManagerRecord, what: string): ReturnType<typeof wrongHost> {
    return wrongHost(
      `manager ${rec.id} runs on ${rec.host}, not on ${hostname()}; ${what} there`,
      rec.host,
    );
  }

  const lookupTurn = opts.sessionTurn ?? sessionTurn;

  /**
   * A manager as a timeline actor, with its current turn.
   *
   * The transcript is the truth when it is HERE. When it is not — the manager
   * runs on a PC and this is its control box — the only reader is that PC, so
   * the turn it reported with the call is used instead, falling back to the one
   * its last heartbeat carried. `reported` is client-asserted, hence never
   * preferred over a transcript this hub can read.
   */
  async function managerStamp(
    rec: ManagerRecord,
    reported?: { turn?: number; prompt?: string },
  ): Promise<TimelineStamp> {
    const local = storeIsLocal(rec);
    const asserted = reported?.turn !== undefined ? reported : freshReport(rec);
    const turn =
      rec.sessionId && local
        ? await lookupTurn(rec.agent, rec.cwd, rec.sessionId).catch(() => undefined)
        : !local && asserted?.turn !== undefined
          ? { turn: asserted.turn, ...(asserted.prompt ? { prompt: asserted.prompt } : {}) }
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
        ? await store.findManager(ref.managerId)
        : await store.findManagerBySession(ref.agent, ref.sessionId);
    if (!rec || (wsId !== undefined && rec.workspaceId !== wsId)) return undefined;
    return managerStamp(rec, 'managerId' in ref ? undefined : ref);
  }

  /**
   * The `manager.started` / `manager.resumed` row for a registration this hub
   * just made — written only when the record lives HERE.
   *
   * A remote store's `registerManager` is a POST to the control box, whose own
   * `registerManager` (below) already writes the row where the workspace is.
   * Forwarding a second one through the timeline sink would log every start and
   * resume twice.
   */
  async function recordRegistration(
    rec: ManagerRecord,
    type: 'manager.started' | 'manager.resumed',
    meta: TimelineMeta | undefined,
  ): Promise<void> {
    if (store.kind !== 'file') return;
    await recordManagerEvent(rec, type, meta);
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

  /** A workspace's records with their box pointers healed; written back only where they live. */
  async function reconciled(wsId: string, ctx: ReconcileContext): Promise<ManagerRecord[]> {
    const current = await store.readManagers(wsId);
    const { managers, changed } = reconcileManagers(current, ctx);
    if (changed && store.kind === 'file') {
      for (const m of managers) {
        await store
          .patchManager(wsId, m.id, { boxIds: m.boxIds, boxJobIds: m.boxJobIds })
          .catch(() => null);
      }
    }
    return managers;
  }

  /**
   * The tmux/daemon/pid snapshot every record on THIS machine is rendered
   * against. Sessions claimed by a record are excluded from the unclaimed
   * `terminalSession` search, so it has to see all of them at once.
   */
  async function localSnapshot(
    records: ManagerRecord[],
  ): Promise<{ snap?: BackgroundSessionSnapshot; claimed: Set<string> }> {
    // Only a claude session on this machine can be in Claude's daemon or in a
    // tmux session here; a workspace without one never pays for the lookup.
    const snap = records.some((r) => r.agent === 'claude' && storeIsLocal(r))
      ? await lookupBackground()
      : undefined;
    const claimed = new Set<string>();
    for (const r of records) {
      claimed.add(managerSessionName(r.id));
      if (r.tmuxSession) claimed.add(r.tmuxSession);
    }
    return { ...(snap ? { snap } : {}), claimed };
  }

  /** One record on this machine, rendered from what can be probed here. */
  async function probedView(
    rec: ManagerRecord,
    ctx: {
      workspaceId: string;
      workspaceName: string;
      tasks: WorkTask[];
      snap?: BackgroundSessionSnapshot;
      claimed: Set<string>;
    },
  ): Promise<ManagerView> {
    const { snap, claimed } = ctx;
    const local = snap !== undefined && rec.agent === 'claude';
    // Probed up front only for a pty manager, whose own liveness decides whether
    // its Claude session counts as detached. For every other record the daemon
    // can still answer `running` on its own, and probing first would spend a
    // `tmux has-session` per manager on every list.
    const probed = rec.kind === 'pty' ? await managerStatus(rec, probe) : undefined;
    const background = local
      ? backgroundFor(rec, snap, { ptyRunning: probed === 'running' })
      : undefined;
    const inDaemon = local ? liveBackgroundSession(rec, snap) : undefined;
    const effective =
      background || inDaemon ? 'running' : (probed ?? (await managerStatus(rec, probe)));
    const own = managerSessionName(rec.id);
    const attachSession =
      background && snap?.managerTmux.some((t) => t.session === own) ? own : null;
    const terminalSession =
      local && snap && rec.kind === 'external' && effective === 'running'
        ? terminalSessionFor(rec, snap, claimed)
        : undefined;
    const lastExit =
      effective === 'stopped' && rec.kind !== 'external' && rec.lastExit === undefined
        ? await readManagerExit(ctx.workspaceId, rec.id)
        : undefined;
    const ptyAttach = effective === 'running' ? ptyAttachOf(rec) : undefined;
    return toManagerView(rec, {
      status: effective,
      hostname: hostname(),
      workspaceName: ctx.workspaceName,
      tasks: ctx.tasks,
      ...(background ? { background, attachSession } : {}),
      ...(terminalSession ? { terminalSession } : {}),
      ...(ptyAttach ? { ptyAttach } : {}),
      ...(lastExit === undefined ? {} : { lastExit }),
    });
  }

  /**
   * The `manager.*` config as the carrier wants it. Resolved on the hub at
   * start time and handed to the host in its spawn spec: a detached host does
   * no config layering of its own, and a live change reaches it as a `configure`
   * message instead.
   */
  async function managerSettings(cwd: string): Promise<{
    carrier: ManagerCarrier;
    pty: Partial<PtyCarrierSettings> & { lifetime: 'leased' | 'persistent' };
  }> {
    const { effective } = await loadEffectiveConfig(cwd);
    const m = effective.manager;
    return {
      carrier: m.carrier,
      pty: {
        lifetime: m.lifetime,
        leaseGraceMs: Math.max(1, m.leaseGraceSeconds) * 1000,
        scrollbackBytes: m.scrollbackBytes,
        submitDelayMs: m.submitDelayMs,
        windowSize: m.windowSize,
      },
    };
  }

  /**
   * Why this machine cannot run `agent`, or null when it can. Absent registry
   * seam (the plane path) means unknown, and unknown is not a refusal.
   */
  function agentNotInstalledHere(agent: string): string | null {
    const sys = globalThis.__AGENTBOX_HUB_SYSTEM;
    if (!sys) return null;
    const known = sys.agents().filter((a) => a.surface !== 'service');
    const row = known.find((a) => a.id === agent);
    if (!row || row.installed) return null;
    const here = known.filter((a) => a.installed).map((a) => a.id);
    return here.length > 0
      ? `${agent} is not set up on ${hostname()}, where this manager would run; installed here: ${here.join(', ')}`
      : `${agent} is not set up on ${hostname()}, where this manager would run`;
  }

  /**
   * The probe a resume takes: the status seams plus the same carrier choice and
   * `manager.*` tunables a fresh start resolves. A resume IS a start.
   */
  async function resumeProbe(rec: ManagerRecord): Promise<
    ManagerProbe & {
      carrier?: ManagerCarrier;
      ptySettings?: Partial<PtyCarrierSettings>;
      spawnPtyHost?: SpawnPtyHost;
    }
  > {
    const settings = await managerSettings(rec.cwd);
    return {
      ...probe,
      carrier: deps.managerCarrier ?? settings.carrier,
      ptySettings: settings.pty,
      ...(deps.spawnPtyHost ? { spawnPtyHost: deps.spawnPtyHost } : {}),
    };
  }

  /**
   * Why this host cannot start a manager session at all, or null when it can.
   *
   * Not `tmuxAvailable` any more: the pty carrier is the default, and a machine
   * with a working pty host and no tmux — the very install the carrier exists to
   * serve — was being refused with "tmux is not installed" before the carrier
   * was ever consulted.
   */
  async function carrierRefusal(cwd: string): Promise<string | null> {
    const carrier = deps.managerCarrier ?? (await managerSettings(cwd)).carrier;
    if (carrier !== 'tmux' && (await resolvePtyHostEntry())) return null;
    if (carrier === 'pty') return PTY_CARRIER_MISSING;
    if (await tmuxAvailable(deps.managerExec)) return null;
    return MANAGER_CARRIER_MISSING;
  }

  /** The argv a client runs to open this manager's terminal, when it has one. */
  function ptyAttachOf(rec: ManagerRecord): ManagerPtyAttach | undefined {
    if (rec.kind !== 'pty') return undefined;
    return ptyAttachFor(rec, process.env['AGENTBOX_CLI_ENTRY'], PTY_PROTOCOL_VERSION);
  }

  /**
   * Views the hub that HOLDS the records rendered, with the ones that run on
   * this machine re-probed here.
   *
   * A remote store answers every status from the last heartbeat — and from no
   * heartbeat at all when this hub was not running to send one. The tmux server,
   * the pid and Claude's daemon are right here, so for our own managers the
   * report is a worse copy of something we can simply read. Everything the
   * holding hub owns (`workspaceName`, `taskCounts`) is kept from its view.
   */
  async function withLocalProbes(views: ManagerView[]): Promise<ManagerView[]> {
    if (!views.some((v) => storeIsLocal(v))) return views;
    const { snap, claimed } = await localSnapshot(views);
    return Promise.all(
      views.map(async (view) => {
        if (!storeIsLocal(view)) return view;
        const probed = await probedView(await withTitle(view), {
          workspaceId: view.workspaceId,
          workspaceName: view.workspaceName,
          tasks: [],
          ...(snap ? { snap } : {}),
          claimed,
        });
        return { ...probed, taskCounts: view.taskCounts };
      }),
    );
  }

  async function viewsOf(ws: ManagerWorkspace, ctx: ReconcileContext): Promise<ManagerView[]> {
    const records = await reconciled(ws.id, ctx);
    if (records.length === 0) return [];
    const tasks = await readTasks(ws.id);
    const { snap, claimed } = await localSnapshot(records);
    return Promise.all(
      records.map(async (raw) => {
        const rec = await withTitle(raw);
        if (!storeIsLocal(rec)) return reportedView(rec, ws, tasks);
        return probedView(rec, {
          workspaceId: ws.id,
          workspaceName: ws.name,
          tasks,
          ...(snap ? { snap } : {}),
          claimed,
        });
      }),
    );
  }

  /**
   * A manager this hub only holds the record for, as its machine last reported
   * it. Nothing here is probed: a pid, a tmux session and a transcript all
   * belong to the other machine. A stale report falls back to `managerStatus`,
   * which for a record with no probe of its own is the `lastSeenAt` window.
   */
  function reportedView(
    rec: ManagerRecord,
    ws: ManagerWorkspace,
    tasks: Awaited<ReturnType<typeof readTasks>>,
  ): ManagerView {
    const beat = freshReport(rec);
    const withReported: ManagerRecord = beat
      ? {
          ...rec,
          ...(beat.sessionId ? { sessionId: beat.sessionId } : {}),
          ...(beat.title ? { title: beat.title } : {}),
          ...(beat.tmuxSession ? { tmuxSession: beat.tmuxSession } : {}),
        }
      : rec;
    const status = beat ? beat.status : seenWindowStatus(rec);
    return toManagerView(withReported, {
      status,
      hostname: hostname(),
      workspaceName: ws.name,
      tasks,
      ...(beat?.background
        ? {
            background: beat.background,
            attachSession:
              beat.tmuxSession === managerSessionName(rec.id) ? managerSessionName(rec.id) : null,
          }
        : {}),
      ...(beat?.terminalSession ? { terminalSession: beat.terminalSession } : {}),
      ...(beat?.lastExit === undefined ? {} : { lastExit: beat.lastExit }),
    });
  }

  /** The no-probe fallback `managerStatus` applies to a record from another machine. */
  function seenWindowStatus(rec: ManagerRecord): 'running' | 'stopped' {
    const seen = Date.parse(rec.lastSeenAt);
    return !Number.isNaN(seen) && now() - seen < MANAGER_SEEN_WINDOW_MS ? 'running' : 'stopped';
  }

  async function viewOf(id: string): Promise<ManagerView | null> {
    // A remote store's hub renders the view: it holds the workspace name, the
    // tasks and every other machine's heartbeats.
    const remote = await store.managerView(id);
    if (remote !== undefined) return remote && (await withLocalProbes([remote]))[0]!;
    const rec = await store.findManager(id);
    if (!rec) return null;
    const ws = await store.readWorkspace(rec.workspaceId);
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
   * The record a detect's `managerId` hint names, when it can be believed. Claude's
   * daemon hands the env of the client that spawned it to every session it hosts,
   * so `$AGENTBOX_MANAGER` reaches sessions that have nothing to do with that
   * manager. Believed only for a record in the same folder that has no session
   * yet (a start whose agent reports for the first time) or that runs in a tmux
   * session here and is running (its agent after a `/clear`).
   */
  async function trustedHint(
    managerId: string | undefined,
    cwd: string,
    runId?: string,
  ): Promise<ManagerRecord | undefined> {
    if (!managerId) return undefined;
    const rec = await store.findManager(managerId);
    if (!rec || rec.cwd !== cwd) return undefined;
    // A pty session proves itself: the host minted this run id and exported it
    // into the agent's own environment, so a leaked $AGENTBOX_MANAGER without it
    // buys nothing.
    if (rec.kind === 'pty' && rec.pty) return runId === rec.pty.runId ? rec : undefined;
    if (!rec.sessionId) return rec;
    if (rec.kind === 'tmux' && (await managerStatus(rec, probe)) === 'running') return rec;
    return undefined;
  }

  /**
   * The AgentBox tmux session a detect says it runs in, when it exists on this
   * machine and started in the detect's folder, and the manager that owns it.
   */
  async function tmuxHome(
    input: DetectManagerInput,
    cwd: string,
  ): Promise<{ owner: ManagerRecord; session: string } | undefined> {
    const name = input.tmuxSession;
    if (!name || !MANAGER_SESSION_RE.test(name) || input.host !== hostname()) return undefined;
    const found = (await listTmuxSessions(deps.managerExec)).find((t) => t.session === name);
    if (!found) return undefined;
    const path = await canonicalWorkspaceRoot(found.path).catch(() => found.path);
    if (path !== cwd) return undefined;
    const owner =
      (await store.findManager(name.slice('agentbox-manager-'.length))) ??
      (await store.listManagers()).find((m) => m.tmuxSession === name);
    return owner?.cwd === cwd ? { owner, session: name } : undefined;
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

  /**
   * What this machine's probes see for a manager it runs, as the hub that holds
   * the record would otherwise have to guess.
   */
  async function heartbeatFor(
    rec: ManagerRecord,
    claimed: ReadonlySet<string>,
  ): Promise<ManagerHeartbeat> {
    const snap = rec.agent === 'claude' ? await lookupBackground() : undefined;
    const ptyProbed = rec.kind === 'pty' ? await managerStatus(rec, probe) : undefined;
    const background = snap
      ? backgroundFor(rec, snap, { ptyRunning: ptyProbed === 'running' })
      : undefined;
    const inDaemon = snap ? liveBackgroundSession(rec, snap) : undefined;
    const status =
      background || inDaemon ? 'running' : (ptyProbed ?? (await managerStatus(rec, probe)));
    const own = managerSessionName(rec.id);
    const showing =
      rec.kind === 'tmux'
        ? (rec.tmuxSession ?? own)
        : snap?.managerTmux.some((t) => t.session === own)
          ? own
          : undefined;
    const title = rec.sessionId
      ? await lookupTitle(rec.agent, rec.cwd, rec.sessionId).catch(() => null)
      : null;
    const turn =
      rec.sessionId && status === 'running'
        ? await lookupTurn(rec.agent, rec.cwd, rec.sessionId).catch(() => undefined)
        : undefined;
    const terminalSession =
      snap && rec.kind === 'external' && status === 'running'
        ? terminalSessionFor(rec, snap, claimed)
        : undefined;
    const lastExit =
      status === 'stopped' && rec.kind !== 'external'
        ? (rec.lastExit ?? (await readManagerExit(rec.workspaceId, rec.id)))
        : undefined;
    return {
      status,
      ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
      ...(title && title !== UNTITLED_SESSION ? { title } : {}),
      ...(turn ? { turn: turn.turn, ...(turn.prompt ? { prompt: turn.prompt } : {}) } : {}),
      ...(lastExit === undefined ? {} : { lastExit }),
      ...(background ? { background } : {}),
      ...(terminalSession ? { terminalSession } : {}),
      ...(showing ? { tmuxSession: showing } : {}),
      ...(status === 'running' && ptyAttachOf(rec) ? { ptyAttach: ptyAttachOf(rec) } : {}),
    };
  }

  /** Report one manager this machine runs, best-effort. */
  async function beat(rec: ManagerRecord): Promise<void> {
    if (store.kind !== 'remote' || !storeIsLocal(rec)) return;
    const claimed = new Set<string>();
    for (const m of await store.listManagers()) {
      claimed.add(managerSessionName(m.id));
      if (m.tmuxSession) claimed.add(m.tmuxSession);
    }
    await store.reportManager(rec.id, await heartbeatFor(rec, claimed)).catch(() => {});
  }

  /** Kill the session and persist the ending, through whichever store holds it. */
  async function persistStop(rec: ManagerRecord): Promise<void> {
    const patch = await stopManagerSession(rec, probe);
    if (patch) await store.patchManager(rec.workspaceId, rec.id, patch);
  }

  return {
    async detectManager(input: DetectManagerInput): Promise<DetectManagerResult> {
      // Detecting mints or moves a record, which only the hub that HOLDS it can
      // do: a remote store refuses the write, and an unhandled rejection here
      // would answer a plain client (the tray, a script, `--url`) with a 500
      // instead of telling it where to go.
      if (store.kind !== 'file') {
        return err(
          `this hub keeps its workspaces on the hub that owns its boxes; register the session there (\`agentbox hub target\` names it)`,
        );
      }
      const host = input.host ?? hostname();
      const cwd = await canonicalWorkspaceRoot(input.cwd);
      const home = await tmuxHome(input, cwd);
      const hinted = home?.owner ?? (await trustedHint(input.managerId, cwd, input.runId));
      // A session already registered stays where it is, even when this call came
      // from a subfolder another workspace contains.
      const known =
        (await store.findManagerBySession(input.agent, input.sessionId)) ?? hinted ?? null;
      let ws = known ? await store.readWorkspace(known.workspaceId) : null;
      let workspaceCreated = false;
      if (!ws) {
        ws = findWorkspaceContaining(await listWorkspaces(), cwd, host);
        if (!ws) {
          const refusal = await autoWorkspaceRefusal(cwd, input.home);
          if (refusal) return invalid(refusal);
          try {
            ws = await addWorkspace({ host, root: cwd, projects: input.projects ?? [] });
            workspaceCreated = true;
          } catch (e) {
            return err(`could not register a workspace at ${cwd}: ${messageOf(e)}`);
          }
        }
      }
      // Only a pid from this machine can be stamped: elsewhere it names another process.
      const pidStartedAt =
        input.pid !== undefined && host === hostname()
          ? await (deps.processStartTime ?? processStartTime)(input.pid).catch(() => undefined)
          : undefined;
      const { manager, created, sessionChanged } = await store.upsertDetectedManager(ws.id, {
        agent: input.agent,
        sessionId: input.sessionId,
        cwd,
        host,
        ...(input.pid !== undefined ? { pid: input.pid } : {}),
        ...(pidStartedAt ? { pidStartedAt } : {}),
        ...(hinted ? { managerId: hinted.id } : {}),
        ...(input.tmuxPane ? { tmuxPane: input.tmuxPane } : {}),
        ...(home ? { tmuxSession: home.session } : {}),
      });
      if (input.boxId) await store.attachBox(ws.id, manager.id, { boxId: input.boxId });
      else if (input.boxJobId) {
        await store.attachBox(ws.id, manager.id, { boxJobId: input.boxJobId });
      }
      // A detect runs on nearly every CLI call; only a new record or a new
      // session in an existing one (`/clear`, a started agent's first call) is news.
      if (created || sessionChanged) {
        await recordManagerEvent(manager, 'manager.joined', { stamp: { actor: 'manager' } });
      }
      deps.notify();
      const [view, workspace] = await Promise.all([viewOf(manager.id), opts.workspaceView(ws.id)]);
      if (!view || !workspace) return err('the manager was not written');
      return { ok: true, manager: view, workspace, created: created || workspaceCreated };
    },

    async listManagers(filter?: ManagerFilter): Promise<ManagerView[]> {
      const remote = await store.managerViews(
        filter?.workspaceId ? { workspaceId: filter.workspaceId } : {},
      );
      if (remote) {
        const views = await withLocalProbes(remote);
        return sortViews(filter?.status ? views.filter((v) => v.status === filter.status) : views);
      }
      const all = await listWorkspaces();
      const wanted = filter?.workspaceId ? all.filter((w) => w.id === filter.workspaceId) : all;
      if (wanted.length === 0) return [];
      const ctx = await reconcileContext(deps);
      const views = (await Promise.all(wanted.map((ws) => viewsOf(ws, ctx)))).flat();
      return sortViews(filter?.status ? views.filter((v) => v.status === filter.status) : views);
    },

    getManager: viewOf,

    async listWorkspaceManagers(wsId: string): Promise<ManagerView[] | null> {
      const remote = await store.managerViews({ workspaceId: wsId });
      if (remote) return sortViews(await withLocalProbes(remote));
      const ws = await store.readWorkspace(wsId);
      if (!ws) return null;
      return sortViews(await viewsOf(ws, await reconcileContext(deps)));
    },

    async startManager(
      wsId: string,
      input: StartManagerInput,
      meta?: TimelineMeta,
    ): Promise<ManagerResult> {
      const ws = await store.readWorkspace(wsId);
      if (!ws) return err(`unknown workspace ${wsId}`);
      if (input.sessionId && !isResumableManagerAgent(input.agent)) {
        // The route validator is the accept-list for `agent`; here we only need
        // the one rule it cannot express — starting a FRESH agent that looks
        // resumed is worse than a 400.
        return err(
          `session resume is only supported for ${RESUMABLE_MANAGER_AGENTS.join(', ')}, not ${input.agent}`,
        );
      }
      if (input.sessionId) {
        // A session some manager already holds is resumed AS that manager, so the
        // boxes and tasks it collected stay with it instead of forking a duplicate.
        const existing = await store.findManagerBySession(input.agent, input.sessionId);
        if (existing) {
          if (!storeIsLocal(existing)) return elsewhere(existing, 'resume it');
          const gone = await carrierRefusal(existing.cwd);
          if (gone) return err(gone);
          const inDaemon = await daemonSession(existing, true);
          if (inDaemon) return err(backgroundResumeRefusal(existing, inDaemon));
          try {
            if (
              input.restart &&
              existing.kind !== 'external' &&
              (await managerStatus(existing, probe)) === 'running'
            ) {
              await persistStop(existing);
            }
            await store.registerManager(
              existing.workspaceId,
              await resumeManagerSession(existing, probe),
            );
          } catch (e) {
            return err(messageOf(e));
          }
          await recordRegistration(existing, 'manager.resumed', meta);
          await beat(existing);
          deps.notify();
          return answer(existing.id);
        }
      }
      // A manager is a process in the folder, so it can only start where the
      // folder is. A workspace registered from another machine has none here.
      // Asked BEFORE tmux: a control box holds every workspace and has no
      // folder for any of them, so "start it where the folder is" is the whole
      // answer — a missing tmux there is about a job it must never take.
      const root = workspaceRootOn(ws, hostname());
      if (!root) {
        const elsewhereHosts = Object.keys(ws.hosts);
        const message = `workspace ${ws.name} has no folder on ${hostname()}; start its manager on the machine that has one`;
        return elsewhereHosts[0]
          ? wrongHost(message, elsewhereHosts[0], elsewhereHosts)
          : err(message);
      }
      // Now that this hub IS the machine that will run it, ask whether the agent
      // is actually here. A box installs its agent on demand; a manager runs on
      // this host, where nothing will — without this the start answers 200 and
      // the session dies a second later with exit 127.
      const notInstalled = agentNotInstalledHere(input.agent);
      if (notInstalled) return err(notInstalled);
      const carrierGone = await carrierRefusal(root);
      if (carrierGone) return err(carrierGone);
      const at = new Date().toISOString();
      const manager: ManagerRecord = {
        id: newManagerId(),
        workspaceId: ws.id,
        agent: input.agent,
        // Provisional: the registration the carrier returns says which it is.
        kind: 'tmux',
        cwd: root,
        host: hostname(),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        boxIds: [],
        boxJobIds: [],
        createdAt: at,
        lastSeenAt: at,
      };
      // Read where the session will RUN, so a project's own `manager.*` keys
      // apply to its manager — the hub's cwd is nobody's project.
      const settings = await managerSettings(root);
      let registration: ManagerRegistration;
      try {
        registration = await startManagerSession({
          wsId: ws.id,
          manager,
          argv: buildManagerArgv(input.agent, input.sessionId),
          hostname,
          ...(deps.managerExec ? { exec: deps.managerExec } : {}),
          ...(deps.spawnPtyHost ? { spawnPtyHost: deps.spawnPtyHost } : {}),
          carrier: deps.managerCarrier ?? settings.carrier,
          ptySettings: settings.pty,
        });
      } catch (e) {
        return err(`could not start the manager: ${messageOf(e)}`);
      }
      try {
        await store.registerManager(ws.id, registration);
      } catch (e) {
        // The agent is already running, and with no record nothing points at it:
        // every retry would mint a new id and leave another session in the
        // folder. Kill it so the error the user reads is the whole truth.
        await stopManagerSession(
          {
            ...manager,
            kind: registration.kind,
            ...(registration.tmuxSession ? { tmuxSession: registration.tmuxSession } : {}),
            ...(registration.pty ? { pty: registration.pty } : {}),
          },
          probe,
        ).catch(() => null);
        return err(`could not start the manager: ${messageOf(e)}`);
      }
      await recordRegistration(manager, 'manager.started', meta);
      await beat(manager);
      deps.notify();
      return answer(manager.id);
    },

    /**
     * Record a session another machine opened. The record is minted (or moved)
     * here, where the workspace is, and the event says which it was: a
     * registration naming an existing manager is that manager resumed.
     */
    async registerManager(
      wsId: string,
      input: ManagerRegistration,
      meta?: TimelineMeta,
    ): Promise<ManagerResult> {
      const ws = await store.readWorkspace(wsId);
      if (!ws) return err(`unknown workspace ${wsId}`);
      const previous = input.id ? await store.findManager(input.id) : null;
      if (previous && previous.workspaceId !== wsId) {
        return err(`manager ${input.id ?? ''} belongs to another workspace`);
      }
      const manager = await store.registerManager(wsId, input);
      if (!manager) return err('the manager was not written');
      await recordManagerEvent(manager, previous ? 'manager.resumed' : 'manager.started', meta);
      deps.notify();
      return answer(manager.id);
    },

    async reportManager(id: string, beat: ManagerHeartbeat): Promise<ManagerResult> {
      const rec = await store.findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      if (storeIsLocal(rec)) {
        // Here the process itself is readable, and a report — which nothing can
        // check — would let a stale claim override what this hub can see.
        return wrongHost(
          `manager ${id} runs on this hub (${hostname()}); its state is probed here, not reported`,
          rec.host,
        );
      }
      const at = new Date(now()).toISOString();
      await store.patchManager(rec.workspaceId, id, {
        reported: beat,
        reportedAt: at,
        // The window the record falls back to once the report goes stale. Only a
        // running report is evidence of life: stamping it on a `stopped` one
        // would make the fallback read `running` for another 30 minutes.
        ...(beat.status === 'running' ? { lastSeenAt: at } : {}),
        // A record detected before its agent had a session (or a title) learns
        // both from the machine that can read the transcript.
        ...(beat.sessionId && !rec.sessionId ? { sessionId: beat.sessionId } : {}),
        ...(beat.title && !rec.title ? { title: beat.title } : {}),
      });
      deps.notify();
      return answer(id);
    },

    async resumeManager(id: string, meta?: TimelineMeta): Promise<ManagerResult> {
      const rec = await store.findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      if (!storeIsLocal(rec)) return elsewhere(rec, 'resume it');
      const inDaemon = await daemonSession(rec, true);
      if (inDaemon) return err(backgroundResumeRefusal(rec, inDaemon));
      const carrierGone = await carrierRefusal(rec.cwd);
      if (carrierGone) return err(carrierGone);
      try {
        await store.registerManager(
          rec.workspaceId,
          await resumeManagerSession(rec, await resumeProbe(rec)),
        );
      } catch (e) {
        return err(messageOf(e));
      }
      await recordRegistration(rec, 'manager.resumed', meta);
      await beat(rec);
      deps.notify();
      return answer(id);
    },

    async attachManager(id: string): Promise<ManagerResult> {
      const rec = await store.findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      if (!storeIsLocal(rec)) return elsewhere(rec, 'attach to it');
      const snap = rec.agent === 'claude' ? await lookupBackground({ fresh: true }) : undefined;
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
        const patch = await attachBackgroundSession({
          wsId: rec.workspaceId,
          manager: rec,
          backgroundId: background.id,
          ...(deps.managerExec ? { exec: deps.managerExec } : {}),
        });
        await store.patchManager(rec.workspaceId, rec.id, patch);
      } catch (e) {
        return err(`could not attach: ${messageOf(e)}`);
      }
      // The snapshot predates the session just started; the answer must show it.
      await lookupBackground({ fresh: true });
      await beat(rec);
      deps.notify();
      return answer(id);
    },

    /**
     * Pin a session so nothing reaps it when its last client leaves, or unpin
     * it. Written to the record AND pushed to the live host: the record is what
     * a restart reads, the host is what actually enforces it right now.
     */
    async pinManager(id: string, pinned: boolean): Promise<ManagerResult> {
      const rec = await store.findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      if (rec.kind === 'external') {
        return err(`manager ${id} runs in your terminal; the hub does not keep it alive`);
      }
      await store.patchManager(rec.workspaceId, id, { pinned });
      if (storeIsLocal(rec) && rec.kind === 'pty') {
        const meta = await readPtyMeta(id);
        if (meta) await ptyConfigure(meta, { pinned });
      }
      deps.notify();
      return answer(id);
    },

    async stopManager(id: string, meta?: TimelineMeta): Promise<ManagerResult> {
      const rec = await store.findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      if (!storeIsLocal(rec)) return elsewhere(rec, 'stop it');
      const inDaemon = await daemonSession(rec, true);
      if (inDaemon && rec.kind === 'external') {
        // Its session is Claude's daemon's, not the hub's: only the attach client goes.
        const patch = await detachBackgroundSession(rec, deps.managerExec);
        if (patch) await store.patchManager(rec.workspaceId, id, patch);
        await lookupBackground({ fresh: true });
        await beat(rec);
        deps.notify();
        const view = await viewOf(id);
        return view
          ? { ok: true, manager: view, notice: BACKGROUND_STOP_NOTICE }
          : err(`unknown manager ${id}`);
      }
      const wasRunning = (await managerStatus(rec, probe)) === 'running';
      try {
        await persistStop(rec);
      } catch (e) {
        return err(messageOf(e));
      }
      // Stop is idempotent: stopping a session that had already ended is not an event.
      if (wasRunning) await recordManagerEvent(rec, 'manager.stopped', meta);
      await beat(rec);
      deps.notify();
      const stopped = await answer(id);
      return stopped.ok && inDaemon ? { ...stopped, notice: BACKGROUND_STOP_NOTICE } : stopped;
    },

    async removeManager(id: string, opts: { force?: boolean } = {}): Promise<ActionResult> {
      const rec = await store.findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      // A record is the only handle on a running process: forgetting it would
      // leave a tmux session (or a terminal session's boxes) nothing points at.
      // `force` is the way out when the status is wrong (a pid the probe cannot
      // tell apart, a last-seen window that has not lapsed yet).
      const running = storeIsLocal(rec)
        ? (await effectiveStatus(rec)) === 'running'
        : (freshReport(rec)?.status ?? seenWindowStatus(rec)) === 'running';
      if (!opts.force && running) {
        return err(`manager ${id} is running; stop it before forgetting it (or force it)`);
      }
      // A control box takes only a registration, a heartbeat and a box attach
      // from another host, so a remote store REFUSES this — answering `ok` would
      // report a record forgotten that is still there.
      if (!(await store.removeManagerRecord(rec.workspaceId, id))) {
        return err(
          store.kind === 'remote'
            ? `manager ${id}'s record lives on the hub that owns its workspace, not on ${hostname()}; forget it there (\`agentbox manager forget ${id}\`, which targets that hub)`
            : `manager ${id} was not forgotten; it may have been removed already`,
        );
      }
      deps.notify();
      return { ok: true };
    },

    async listManagerSessions(wsId: string, agent?: string): Promise<ManagerSessionsAnswer | null> {
      const ws = await store.readWorkspace(wsId);
      if (!ws) return null;
      // The agent's sessions are files in the folder's own store: nothing to
      // list for a workspace whose folder is on another machine.
      const root = workspaceRootOn(ws, hostname());
      if (!root) {
        const elsewhereHosts = Object.keys(ws.hosts);
        const message = `workspace ${ws.name} has no folder on ${hostname()}; its agent sessions are on the machine that has one`;
        return elsewhereHosts[0]
          ? wrongHost(message, elsewhereHosts[0], elsewhereHosts)
          : err(message);
      }
      return { ok: true, sessions: await listResumableHostSessions(root, agent ?? 'claude') };
    },

    timelineStamp,

    async addManagerNote(id, input, meta): Promise<ManagerNoteResult> {
      const rec = await store.findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      // A note is attributed to the manager it names. When the caller IS that
      // manager (`agentbox manager note` from inside its own session), its
      // session header carries the turn it read from its transcript — the only
      // reader of it when the transcript is on another machine. Any other
      // caller's turn belongs to a different session and is dropped.
      const asserted = await stampInWorkspace(meta, rec.workspaceId, timelineStamp);
      const stamp =
        asserted?.actor === 'manager' && asserted.managerId === rec.id
          ? asserted
          : await managerStamp(rec);
      const event = await timelineSink().record(rec.workspaceId, {
        type: 'manager.note',
        ...stampFields(stamp),
        text: input.text,
        noteKind: input.kind ?? 'note',
      });
      // Here the log write IS the mutation, so unlike every other writer a miss is an error.
      if (!event) return err(`the note for manager ${id} was not recorded`);
      deps.notify();
      return { ok: true, event };
    },

    async sendManagerMessage(id, input, meta): Promise<ManagerMessageResult> {
      const rec = await store.findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      if (!storeIsLocal(rec)) {
        // Typing needs the tmux server the session runs under. The client
        // retries against the hub on that machine, which is its own when the
        // host is its hostname.
        return {
          ok: false,
          code: 'manager_unreachable',
          error: `manager ${id} runs on ${rec.host}; this hub (${hostname()}) cannot type into it`,
          details: { host: rec.host },
        };
      }
      const status = await managerStatus(rec, probe);
      let delivered: ManagerMessageDelivery;
      try {
        if (status === 'running' && rec.kind === 'pty') {
          // The host does the typing: it owns the pty, so the pause before
          // Enter lands where it is precise rather than a `tmux send-keys`
          // round trip away.
          const meta = rec.pty ? await readPtyMeta(rec.id) : undefined;
          if (!meta) {
            return {
              ok: false,
              code: 'manager_unreachable',
              error: `manager ${id} has no live pty host to type into`,
            };
          }
          if (!(await ptyInject(meta, input.text))) {
            return {
              ok: false,
              code: 'manager_unreachable',
              error: `manager ${id}'s pty host did not accept the message`,
            };
          }
          delivered = 'session';
        } else if (status === 'running' && rec.kind === 'tmux') {
          await sendKeysToManager(
            { session: rec.tmuxSession ?? managerSessionName(rec.id) },
            input.text,
            deps.managerExec,
            opts.sleep,
          );
          delivered = 'session';
        } else if (status === 'running') {
          if (!rec.tmuxPane) {
            return {
              ok: false,
              code: 'manager_unreachable',
              error: `manager ${id} runs in your terminal outside tmux, where the hub cannot type; paste the message into that session`,
            };
          }
          await sendKeysToManager({ pane: rec.tmuxPane }, input.text, deps.managerExec, opts.sleep);
          delivered = 'pane';
        } else {
          const carrierGone = await carrierRefusal(rec.cwd);
          if (carrierGone) return err(carrierGone);
          await store.registerManager(
            rec.workspaceId,
            await resumeManagerSession(rec, await resumeProbe(rec), { prompt: input.text }),
          );
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
      await beat(rec);
      deps.notify();
      const view = await viewOf(id);
      if (!view) return err(`unknown manager ${id}`);
      return { ok: true, delivered, manager: view, event };
    },

    async attachManagerBox(managerId: string, target: ManagerBoxTarget): Promise<ActionResult> {
      const rec = await store.findManager(managerId);
      if (!rec) return err(`unknown manager ${managerId}`);
      // Through the store, not the file: the hub that BUILT the box may not be
      // the one holding the record (`hub.mode=local` under a control box).
      await store.attachBox(rec.workspaceId, managerId, target);
      deps.notify();
      return { ok: true };
    },

    async reportManagers(): Promise<number> {
      if (store.kind !== 'remote') return 0;
      const records = (await store.listManagers()).filter(storeIsLocal);
      if (records.length === 0) return 0;
      const claimed = new Set<string>();
      for (const m of records) {
        claimed.add(managerSessionName(m.id));
        if (m.tmuxSession) claimed.add(m.tmuxSession);
      }
      for (const rec of records) {
        await store.reportManager(rec.id, await heartbeatFor(rec, claimed)).catch(() => {});
      }
      return records.length;
    },

    async managerByBox(): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      const ctx = await reconcileContext(deps);
      for (const m of reconcileManagers(await store.listManagers(), ctx).managers) {
        for (const boxId of m.boxIds) out.set(boxId, m.id);
        for (const jobId of m.boxJobIds) out.set(jobId, m.id);
      }
      return out;
    },
  };
}
