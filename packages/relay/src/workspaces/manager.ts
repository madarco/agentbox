import { randomBytes } from 'node:crypto';
import {
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { homedir, hostname as osHostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execa } from 'execa';
import { withFileLock } from '@agentbox/config';
import {
  AGENT_SESSION_ENV_VARS,
  encodeClaudeProjectsKey,
  scrubAgentSessionEnv,
} from '@agentbox/sandbox-core';
import {
  listWorkspaces,
  managerExitFile,
  managersFile,
  readWorkspace,
  resolveWorkspaceDir,
  WORKSPACE_LOCK,
  workspaceDir,
} from './workspace-store.js';
import type { ReconcileContext } from './task-store.js';
import type {
  HostSession,
  ManagerAgent,
  ManagerBackground,
  ManagerFile,
  ManagerHeartbeat,
  ManagerKind,
  ManagerRecord,
  ManagerRecordPatch,
  ManagerRegistration,
  ManagerResumeBlock,
  ManagerStatus,
  ManagerView,
  WorkTask,
} from './types.js';

/** Seam for every tmux, `ps` and `claude agents` call, so tests assert argv without a terminal. */
export type ManagerExec = (
  file: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ exitCode?: number | undefined; stdout?: string }>;

const defaultExec: ManagerExec = (file, args, opts) => execa(file, args, opts);

/** Read at most this much of a transcript when scraping its first user turn. */
const SESSION_HEAD_BYTES = 256 * 1024;

/**
 * A rollout's first record can be enormous — its `session_meta` carries the
 * agent's base instructions and every configured tool, measured at 49 KB on a
 * plain setup and growing with each MCP server. The folder sits ~200 bytes into
 * it, but the line only parses whole, so the reader follows the line rather than
 * a fixed head. The cap is a bound on a pathological file, not on a normal one.
 */
const SESSION_FIRST_LINE_MAX = 4 * 1024 * 1024;
const SESSION_TITLE_MAX = 120;
const SESSION_LIST_MAX = 50;
/** What a listing shows for a session with no usable first turn yet. Never a title to keep. */
export const UNTITLED_SESSION = '(untitled)';

/**
 * Read at most this much of a session-title index. It is append-only, so the
 * rows a picker needs are the NEWEST ones — read the tail, not the head.
 */
const SESSION_INDEX_BYTES = 1024 * 1024;

/**
 * How many session files one listing may open. A store that is flat across every
 * project holds years of other folders' sessions, and the picker shows 50.
 *
 * The candidates are ranked by mtime BEFORE this cap applies: a session created
 * weeks ago and resumed yesterday keeps writing to its original file, so cutting
 * by filename (creation time) would drop exactly the sessions a user is still
 * working in. Measured drift between the two on a real store: 22 hours.
 */
const ROLLOUT_SCAN_MAX = 200;

/**
 * How many files one listing may `stat` to rank them. Ten times the read budget:
 * a stat is cheap where opening and parsing a multi-megabyte record is not, and
 * this is the outer bound on a store that has grown for years.
 */
const ROLLOUT_STAT_MAX = 2000;

/**
 * `rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl` — the id is the TRAILING 36-char
 * dashed segment, matched explicitly so the date-time prefix cannot be read as one.
 */
const ROLLOUT_UUID_RE =
  /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/u;

/**
 * How each agent we can actually resume spells "continue this session". One
 * takes a flag, the other a SUBCOMMAND (`resume <id>`, verified against codex
 * 0.142.3 — it has no `--resume`), which is why this is a table and not a
 * shared suffix. An agent absent here reports `supported: false`: guessing a
 * spelling would start a FRESH session that looks resumed, which is worse than
 * offering none.
 */
const RESUME_ARGV: Record<string, (sessionId: string) => string[]> = {
  claude: (id) => ['--resume', id],
  codex: (id) => ['resume', id],
};

/** The agents whose host session store we can read AND whose resume argv is verified. */
export const RESUMABLE_MANAGER_AGENTS: readonly string[] = Object.keys(RESUME_ARGV);

export function isResumableManagerAgent(agent: string): boolean {
  return RESUMABLE_MANAGER_AGENTS.includes(agent);
}

/** What a picker opens on when the caller named no agent. */
const DEFAULT_RESUMABLE_AGENT: string = RESUMABLE_MANAGER_AGENTS[0] ?? 'claude';

/** A manager id: 16 lowercase hex, minted here. */
export const MANAGER_ID_RE = /^[0-9a-f]{16}$/u;

export function newManagerId(): string {
  return randomBytes(8).toString('hex');
}

const MANAGER_SESSION_PREFIX = 'agentbox-manager-';

export function managerSessionName(managerId: string): string {
  return `${MANAGER_SESSION_PREFIX}${managerId}`;
}

/**
 * A tmux session name the hub itself creates: `agentbox-manager-<managerId>`, or
 * the single-manager layout's `agentbox-manager-<workspaceId>`. Both are 16 hex.
 */
export const MANAGER_SESSION_RE = /^agentbox-manager-[0-9a-f]{16}$/u;

/**
 * `=name` is tmux's exact-match prefix. Without it `has-session -t foo` matches
 * any session whose name STARTS with foo, so two managers whose ids share a
 * prefix would report each other as running.
 */
function exactTarget(session: string): string {
  return `=${session}`;
}

export function managerAttachCommand(tmuxSession: string): string {
  return `tmux attach -t ${exactTarget(tmuxSession)}`;
}

/**
 * The agent's argv: its binary, plus its own resume spelling when the caller
 * named a session. A sessionId for an agent with no verified spelling is
 * refused upstream rather than guessed at here.
 */
export function buildManagerArgv(
  agent: ManagerAgent,
  sessionId?: string,
  prompt?: string,
): string[] {
  if (!sessionId) return [agent];
  // Last line before the id becomes argv on this machine: a value that reads as
  // an option would be parsed by the AGENT, not by us, and both agents expose
  // flags that drop their approval gate. The API refuses this shape too; the
  // check is here as well because this function is the one that builds argv.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(sessionId)) return [agent];
  const resume = RESUME_ARGV[agent];
  if (!resume) return [agent];
  const text = prompt?.trim();
  // The prompt is caller-supplied text: one that starts with `-` would be parsed
  // as a flag (`--dangerously-skip-permissions`). A leading space keeps it a
  // positional for both argument parsers without changing what the agent reads.
  return text
    ? [agent, ...resume(sessionId), text.startsWith('-') ? ` ${text}` : text]
    : [agent, ...resume(sessionId)];
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(' ');
}

/**
 * The `unset` a manager's pane script starts with. A tmux server that already
 * runs hands its own global environment to a new session, so scrubbing the
 * client's env does not reach the pane. TMUX stays: tmux sets it for the pane.
 */
function unsetAgentSessionEnv(): string {
  return `unset ${AGENT_SESSION_ENV_VARS.join(' ')}`;
}

/**
 * The script the login shell runs. The env rides HERE rather than on `tmux -e`
 * so this works on any tmux version and leaks nothing into other sessions; the
 * trailing capture records the agent's exit code, which is the only trace left
 * once the session is gone.
 */
export function buildManagerShellScript(opts: {
  argv: string[];
  env: Record<string, string>;
  exitFile: string;
}): string {
  const exports = Object.entries(opts.env)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join('; ');
  return `${unsetAgentSessionEnv()}; ${exports}; ${shellJoin(opts.argv)}; __agentbox_rc=$?; printf %s "$__agentbox_rc" > ${shellQuote(opts.exitFile)}; exit $__agentbox_rc`;
}

/**
 * The user's login shell. Load-bearing: the hub is a daemon (launchd / the tray)
 * with none of the user's PATH, so a bare `claude` would not resolve.
 */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  if (env['SHELL']) return env['SHELL'];
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

export async function tmuxAvailable(exec: ManagerExec = defaultExec): Promise<boolean> {
  try {
    await exec('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

export async function tmuxSessionExists(
  session: string,
  exec: ManagerExec = defaultExec,
): Promise<boolean> {
  try {
    await exec('tmux', ['has-session', '-t', exactTarget(session)]);
    return true;
  } catch {
    return false;
  }
}

// ── the managers file ──

async function dirFor(wsId: string): Promise<string> {
  return (await resolveWorkspaceDir(wsId)) ?? workspaceDir(wsId);
}

async function readManagerFile(dir: string): Promise<ManagerRecord[] | null> {
  try {
    const parsed = JSON.parse(await readFile(managersFile(dir), 'utf8')) as ManagerFile;
    return Array.isArray(parsed.managers)
      ? (parsed.managers as StoredManagerRecord[]).map(migrateRecord)
      : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Malformed: an empty list, like a missing tasks.json. The next write replaces it.
    return [];
  }
}

/**
 * A record written before the kind was named after its session: `hub` is today's
 * `tmux`. A record with no `host` predates the field being required and names a
 * session on the machine holding the file — the only machine that wrote it.
 */
type StoredManagerRecord = Omit<ManagerRecord, 'kind' | 'host'> & {
  kind: ManagerKind | 'hub';
  host?: string;
};

function migrateRecord(rec: StoredManagerRecord): ManagerRecord {
  const kind: ManagerKind = rec.kind === 'hub' ? 'tmux' : rec.kind;
  return kind === rec.kind && rec.host
    ? (rec as ManagerRecord)
    : { ...rec, kind, host: rec.host ?? osHostname() };
}

async function readExitFile(file: string): Promise<number | undefined> {
  const raw = await readFile(file, 'utf8').catch(() => '');
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? undefined : n;
}

async function writeManagerFile(dir: string, managers: ManagerRecord[]): Promise<void> {
  const final = managersFile(dir);
  await mkdir(dir, { recursive: true });
  const tmp = `${final}.tmp.${String(process.pid)}.${Date.now().toString(36)}`;
  const doc: ManagerFile = { version: 1, managers };
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  await rename(tmp, final);
}

/** Locked read-modify-write of a workspace's managers (migrating a legacy file on the way). */
export async function updateManagers<T>(
  wsId: string,
  fn: (
    managers: ManagerRecord[],
  ) => { managers: ManagerRecord[]; result: T } | Promise<{ managers: ManagerRecord[]; result: T }>,
): Promise<T> {
  const dir = await dirFor(wsId);
  return withFileLock(
    managersFile(dir),
    async () => {
      const { managers, result } = await fn((await readManagerFile(dir)) ?? []);
      await writeManagerFile(dir, managers);
      return result;
    },
    WORKSPACE_LOCK,
  );
}

export async function readManagers(wsId: string): Promise<ManagerRecord[]> {
  const dir = await resolveWorkspaceDir(wsId);
  if (!dir) return [];
  return (await readManagerFile(dir)) ?? [];
}

/** Every workspace's managers, for a lookup by id or session. */
async function allManagers(): Promise<ManagerRecord[]> {
  const out: ManagerRecord[] = [];
  for (const ws of await listWorkspaces()) out.push(...(await readManagers(ws.id)));
  return out;
}

export async function findManager(id: string): Promise<ManagerRecord | null> {
  return (await allManagers()).find((m) => m.id === id) ?? null;
}

export async function findManagerBySession(
  agent: string,
  sessionId: string,
): Promise<ManagerRecord | null> {
  return (await allManagers()).find((m) => m.agent === agent && m.sessionId === sessionId) ?? null;
}

/**
 * The manager that created this box (or the job that will become it). With
 * `workspaceId`, only a manager of that workspace: a task inherits nothing from
 * a session that belongs to another one.
 */
export async function managerIdForTarget(
  target: { boxId: string } | { boxJobId: string },
  opts: { workspaceId?: string } = {},
): Promise<string | undefined> {
  const hit = (await allManagers()).find(
    (m) =>
      (opts.workspaceId === undefined || m.workspaceId === opts.workspaceId) &&
      ('boxId' in target ? m.boxIds.includes(target.boxId) : m.boxJobIds.includes(target.boxJobId)),
  );
  return hit?.id;
}

/**
 * Apply a serialisable patch: a value sets the field, `null` unsets it. The one
 * place a patch is interpreted, so the file store and the remote one agree.
 */
export function applyManagerPatch(rec: ManagerRecord, patch: ManagerRecordPatch): ManagerRecord {
  const next: Record<string, unknown> = { ...rec };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as unknown as ManagerRecord;
}

/**
 * The record a registration names: an existing one moved onto the session it
 * describes, or a new `tmux` manager. A start clears what belonged to the
 * previous run (its pid, its terminal pane, its ending).
 */
export function registeredManager(
  wsId: string,
  input: ManagerRegistration,
  previous?: ManagerRecord,
  now: Date = new Date(),
): ManagerRecord {
  const at = now.toISOString();
  const base: ManagerRecord = previous ?? {
    id: input.id ?? newManagerId(),
    workspaceId: wsId,
    agent: input.agent,
    kind: 'tmux',
    cwd: input.cwd,
    host: input.host,
    boxIds: [],
    boxJobIds: [],
    createdAt: at,
    lastSeenAt: at,
  };
  const next: ManagerRecord = {
    ...base,
    agent: input.agent,
    kind: 'tmux',
    cwd: input.cwd,
    host: input.host,
    tmuxSession: input.tmuxSession,
    ...(input.argv ? { argv: input.argv } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    startedAt: at,
    lastSeenAt: at,
  };
  delete next.pid;
  delete next.pidStartedAt;
  delete next.tmuxPane;
  delete next.stoppedAt;
  delete next.lastExit;
  delete next.reported;
  delete next.reportedAt;
  return next;
}

/** Locked update of one record; `null` when it is not there. */
export async function patchManager(
  wsId: string,
  id: string,
  fn: (rec: ManagerRecord) => ManagerRecord,
): Promise<ManagerRecord | null> {
  return updateManagers(wsId, (managers) => {
    const idx = managers.findIndex((m) => m.id === id);
    if (idx === -1) return { managers, result: null };
    const next = fn(managers[idx]!);
    const out = [...managers];
    out[idx] = next;
    return { managers: out, result: next };
  });
}

export async function removeManagerRecord(wsId: string, id: string): Promise<boolean> {
  const removed = await updateManagers(wsId, (managers) => {
    const out = managers.filter((m) => m.id !== id);
    return { managers: out, result: out.length !== managers.length };
  });
  if (removed) await rm(managerExitFile(await dirFor(wsId), id), { force: true }).catch(() => {});
  return removed;
}

// ── liveness ──

/**
 * How long a manager with no process handle counts as running after it was last
 * seen. A codex session in its default sandbox cannot run `ps`, and a remote hub
 * cannot probe a pid on another machine; both fall back to this window.
 */
export const MANAGER_SEEN_WINDOW_MS = 30 * 60 * 1000;

/** `kill(pid, 0)`: ESRCH = gone; EPERM = alive but not ours to signal. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * When a process started, as `ps` prints it, or undefined when it cannot be read.
 * A pid is reused once its process exits, so a live pid alone does not say the
 * session is still there; its start time does.
 */
export async function processStartTime(pid: number): Promise<string | undefined> {
  try {
    const r = await execa('ps', ['-o', 'lstart=', '-p', String(pid)], {
      // lstart is locale-formatted: pin it so two reads compare equal.
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 2000,
      reject: false,
    });
    const out = r.exitCode === 0 ? r.stdout.trim() : '';
    return out || undefined;
  } catch {
    return undefined;
  }
}

export interface ManagerProbe {
  exec?: ManagerExec;
  hostname?: () => string;
  isPidAlive?: (pid: number) => boolean;
  processStartTime?: (pid: number) => Promise<string | undefined>;
  now?: () => number;
}

/** Derived from the process, never from the record, and never writes. */
export async function managerStatus(
  rec: ManagerRecord,
  probe: ManagerProbe = {},
): Promise<ManagerStatus> {
  const host = (probe.hostname ?? osHostname)();
  if (rec.kind === 'tmux' && rec.host === host) {
    const session = rec.tmuxSession ?? managerSessionName(rec.id);
    return (await tmuxSessionExists(session, probe.exec ?? defaultExec)) ? 'running' : 'stopped';
  }
  // A pid is only meaningful on the machine it came from: probing it on a remote
  // hub would ask about whatever unrelated process holds that number there.
  if (rec.pid !== undefined && rec.host === host) {
    if (!(probe.isPidAlive ?? isPidAlive)(rec.pid)) return 'stopped';
    if (rec.pidStartedAt) {
      // An unreadable start time is not evidence the process changed.
      const started = await (probe.processStartTime ?? processStartTime)(rec.pid);
      if (started !== undefined && started !== rec.pidStartedAt) return 'stopped';
    }
    return 'running';
  }
  const now = (probe.now ?? Date.now)();
  const seen = Date.parse(rec.lastSeenAt);
  return !Number.isNaN(seen) && now - seen < MANAGER_SEEN_WINDOW_MS ? 'running' : 'stopped';
}

/** The agent's exit code, written by the wrapper the hub started it under. */
export async function readManagerExit(wsId: string, id: string): Promise<number | undefined> {
  return readExitFile(managerExitFile(await dirFor(wsId), id));
}

/**
 * The session's transcript, tmux server and pid are only on the machine it runs
 * on, so no other hub can resume it — whatever kind it is.
 */
export function ranElsewhere(rec: ManagerRecord, host: string): boolean {
  return rec.host !== host;
}

/**
 * Why `resumeManagerSession` would refuse this manager right now, checked in the
 * order it checks, so a client's wording matches the error a resume would get.
 * WHERE it may be resumed is `host`, which the caller compares itself.
 */
export function managerResumeBlock(
  rec: ManagerRecord,
  status: ManagerStatus,
): ManagerResumeBlock | undefined {
  if (status === 'running') return 'running';
  if (!rec.sessionId) return 'no-session';
  if (!isResumableManagerAgent(rec.agent)) return 'unsupported-agent';
  return undefined;
}

/** Whether `resumeManagerSession` would accept this manager right now. */
export function isManagerResumable(rec: ManagerRecord, status: ManagerStatus): boolean {
  return managerResumeBlock(rec, status) === undefined;
}

/** The API view: the record without its argv, plus what a list row shows. */
export function toManagerView(
  rec: ManagerRecord,
  ctx: {
    status: ManagerStatus;
    workspaceName: string;
    tasks: WorkTask[];
    lastExit?: number;
    /** The reading hub's hostname, for `hostIsHub`; defaults to this machine's. */
    hostname?: string;
    /** The manager's detached Claude background session (see `backgroundFor`). */
    background?: ManagerBackground;
    /**
     * With `background`: the hub's attach session when it is up, else null. It
     * replaces the hub-run rule for `attachCommand`: the manager runs whether or
     * not anything is attached.
     */
    attachSession?: string | null;
    /** An unclaimed AgentBox tmux session in the manager's folder (see `terminalSessionFor`). */
    terminalSession?: string;
  },
): ManagerView {
  const block = managerResumeBlock(rec, ctx.status);
  const view: ManagerView & {
    argv?: string[];
    reported?: ManagerHeartbeat;
    reportedAt?: string;
  } = {
    ...rec,
    status: ctx.status,
    hostIsHub: rec.host === (ctx.hostname ?? osHostname()),
    resumable: block === undefined,
    ...(block ? { resumeBlockedBy: block } : {}),
    workspaceName: ctx.workspaceName,
    taskCounts: {
      open: ctx.tasks.filter((t) => t.managerId === rec.id && t.status !== 'done').length,
      done: ctx.tasks.filter((t) => t.managerId === rec.id && t.status === 'done').length,
    },
  };
  delete view.argv;
  delete view.reported;
  delete view.reportedAt;
  if (ctx.terminalSession) view.terminalSession = ctx.terminalSession;
  if (ctx.background) {
    view.background = ctx.background;
    if (ctx.attachSession) view.attachCommand = managerAttachCommand(ctx.attachSession);
    // An external record keeps the name of an attach session that has ended.
    else if (rec.kind === 'external') delete view.tmuxSession;
  }
  if (ctx.status === 'running') {
    // A live session next to a previous run's ending reads as contradictory state.
    delete view.stoppedAt;
    delete view.lastExit;
    if (rec.kind === 'tmux' && !ctx.background) {
      view.attachCommand = managerAttachCommand(rec.tmuxSession ?? managerSessionName(rec.id));
    }
  } else if (view.lastExit === undefined && ctx.lastExit !== undefined) {
    view.lastExit = ctx.lastExit;
  }
  return view;
}

// ── detection ──

export interface DetectManagerInput {
  agent: ManagerAgent;
  sessionId: string;
  /** Realpath of the folder the session runs in. */
  cwd: string;
  pid?: number;
  /** The pid's start time on the hub's machine; only when `host` is the hub's. */
  pidStartedAt?: string;
  /** `os.hostname()` of the machine the session runs on. */
  host: string;
  /** `$AGENTBOX_MANAGER` of the caller: set inside a hub-run manager's own session. */
  managerId?: string;
  /** `$TMUX_PANE` when the session's terminal runs inside tmux. */
  tmuxPane?: string;
  /**
   * An AgentBox manager tmux session the caller runs in, already checked by the
   * hub to exist on this machine and to start in `cwd`. The record is run from
   * that session from now on (`tmux`), whatever it was before.
   */
  tmuxSession?: string;
}

/**
 * Register (or refresh) the host session a CLI call came from.
 *
 * Matched by `(agent, sessionId)` first. Failing that, a `managerId` hint names
 * the hub-run manager the call came from — the hub started it before its agent
 * had a session id, so this is where the two are joined. Anything else is a new
 * `external` manager: a session in the user's own terminal.
 */
export async function upsertDetectedManager(
  wsId: string,
  input: DetectManagerInput,
  now: Date = new Date(),
): Promise<{ manager: ManagerRecord; created: boolean; sessionChanged: boolean }> {
  return updateManagers<{ manager: ManagerRecord; created: boolean; sessionChanged: boolean }>(
    wsId,
    (managers) => {
      const at = now.toISOString();
      let idx = managers.findIndex(
        (m) => m.agent === input.agent && m.sessionId === input.sessionId,
      );
      if (idx === -1 && input.managerId) idx = managers.findIndex((m) => m.id === input.managerId);
      if (idx === -1) {
        const manager: ManagerRecord = input.tmuxSession
          ? {
              id: newManagerId(),
              workspaceId: wsId,
              agent: input.agent,
              kind: 'tmux',
              cwd: input.cwd,
              sessionId: input.sessionId,
              host: input.host,
              tmuxSession: input.tmuxSession,
              boxIds: [],
              boxJobIds: [],
              createdAt: at,
              lastSeenAt: at,
            }
          : {
              id: newManagerId(),
              workspaceId: wsId,
              agent: input.agent,
              kind: 'external',
              cwd: input.cwd,
              sessionId: input.sessionId,
              host: input.host,
              ...(input.pid !== undefined ? { pid: input.pid } : {}),
              ...(input.pid !== undefined && input.pidStartedAt
                ? { pidStartedAt: input.pidStartedAt }
                : {}),
              ...(input.tmuxPane ? { tmuxPane: input.tmuxPane } : {}),
              boxIds: [],
              boxJobIds: [],
              createdAt: at,
              lastSeenAt: at,
            };
        return {
          managers: [...managers, manager],
          result: { manager, created: true, sessionChanged: false },
        };
      }
      const prev = managers[idx]!;
      const next: ManagerRecord = { ...prev, sessionId: input.sessionId, lastSeenAt: at };
      // `/clear` starts a new session in the same process: the cached title named
      // the old one.
      if (prev.sessionId !== input.sessionId) delete next.title;
      const fromOwnSession = input.managerId !== undefined && input.managerId === prev.id;
      if (input.tmuxSession) {
        // Run from an AgentBox tmux session: that session is its home, whatever
        // was detected before (an external record from the same session's pid).
        next.kind = 'tmux';
        next.tmuxSession = input.tmuxSession;
        delete next.pid;
        delete next.pidStartedAt;
        delete next.tmuxPane;
        delete next.stoppedAt;
        delete next.lastExit;
      } else if (prev.kind === 'tmux' && !fromOwnSession && input.pid !== undefined) {
        // The session is being run from somewhere other than the hub's tmux — the
        // user resumed it in a terminal. Observe that process from now on.
        next.kind = 'external';
        delete next.tmuxSession;
        delete next.argv;
        delete next.startedAt;
        delete next.stoppedAt;
        delete next.lastExit;
      }
      next.host = input.host;
      if (next.kind === 'external') {
        if (input.pid !== undefined) next.pid = input.pid;
        else delete next.pid;
        if (input.pid !== undefined && input.pidStartedAt) next.pidStartedAt = input.pidStartedAt;
        else delete next.pidStartedAt;
        if (input.tmuxPane) next.tmuxPane = input.tmuxPane;
        else delete next.tmuxPane;
      }
      const out = [...managers];
      out[idx] = next;
      return {
        managers: out,
        result: {
          manager: next,
          created: false,
          sessionChanged: prev.sessionId !== input.sessionId,
        },
      };
    },
  );
}

/** Record that a manager created this box (or the create job that will become it). */
export async function attachBoxToManager(
  wsId: string,
  id: string,
  target: { boxId: string } | { boxJobId: string },
): Promise<ManagerRecord | null> {
  return patchManager(wsId, id, (rec) => {
    if ('boxId' in target) {
      return rec.boxIds.includes(target.boxId)
        ? rec
        : { ...rec, boxIds: [...rec.boxIds, target.boxId] };
    }
    return rec.boxJobIds.includes(target.boxJobId)
      ? rec
      : { ...rec, boxJobIds: [...rec.boxJobIds, target.boxJobId] };
  });
}

/**
 * Forget a box that is gone. The EVENT says so — a destroy, or a prune that
 * dropped the record — because absence from a hub's own inventory does not: a
 * box created on another machine reporting to the same store is simply not
 * listed there, and pruning on that would empty every such manager.
 */
export async function detachBoxFromManagers(wsId: string, boxId: string): Promise<void> {
  await updateManagers(wsId, (managers) => {
    const out = managers.map((m) =>
      m.boxIds.includes(boxId) ? { ...m, boxIds: m.boxIds.filter((b) => b !== boxId) } : m,
    );
    return { managers: out, result: undefined };
  });
}

const FAILED_JOB_STATUSES = new Set(['failed', 'cancelled']);

/**
 * Heal box pointers against reality, with the same rules as `reconcileTasks`: a
 * job that recorded its box is promoted to that box, and an explicitly failed
 * job is dropped (a swept manifest is not evidence of failure).
 *
 * A box id is NOT healed from an inventory listing, for the same reason a task's
 * is not: only an explicit destroy or prune (`detachBoxFromManagers`) is evidence
 * the box is gone.
 */
export function reconcileManagers(
  managers: ManagerRecord[],
  ctx: ReconcileContext,
): { managers: ManagerRecord[]; changed: boolean } {
  const jobById = new Map(ctx.jobs.map((j) => [j.id, j]));
  let changed = false;
  const out = managers.map((m) => {
    const boxIds = [...m.boxIds];
    const boxJobIds: string[] = [];
    for (const jobId of m.boxJobIds) {
      const job = jobById.get(jobId);
      if (job?.boxId) {
        if (!boxIds.includes(job.boxId)) boxIds.push(job.boxId);
        continue;
      }
      if (job && FAILED_JOB_STATUSES.has(job.status)) continue;
      boxJobIds.push(jobId);
    }
    const same = boxIds.length === m.boxIds.length && boxJobIds.length === m.boxJobIds.length;
    if (same) return m;
    changed = true;
    return { ...m, boxIds, boxJobIds };
  });
  return { managers: out, changed };
}

/** A workspace's managers with their box pointers healed; written back only when something moved. */
export async function readReconciledManagers(
  wsId: string,
  ctx: ReconcileContext,
): Promise<ManagerRecord[]> {
  const current = await readManagers(wsId);
  if (current.length === 0 || !reconcileManagers(current, ctx).changed) return current;
  return updateManagers(wsId, (managers) => {
    const { managers: healed } = reconcileManagers(managers, ctx);
    return { managers: healed, result: healed };
  });
}

// ── hub-run sessions ──

/** A refusal that is about the manager's current state, not the request's shape. */
export class ManagerConflictError extends Error {}

export interface ManagerFooterInput {
  agent: string;
  /** The session id's head when known, else the manager id's. */
  shortId: string;
  workspaceName?: string;
}

/** The attach footer's colours (`statusLine` in the CLI): dark bar, blue brand block, white keys. */
const FOOTER_BAR_STYLE = 'bg=#303030,fg=colour250';

/** tmux reads `#` in a status format as a directive, and passes the result through strftime. */
function tmuxFormatText(text: string): string {
  return text.replace(/#/gu, '##').replace(/%/gu, '%%');
}

/**
 * The manager session's status line, drawn to look like the box attach footer.
 * Static text and tmux's own variables only: a `#()` command would be re-run by
 * every client's status refresh. `#{prefix}` is the user's real prefix key.
 */
export function managerStatusFormat(input: ManagerFooterInput): string {
  const hint = (key: string, label: string): string =>
    `#[fg=colour255]${key}#[fg=colour245]: ${label}`;
  const hints = [hint('#{prefix} d', 'detach'), hint('wheel', 'scroll')].join('   │   ');
  const label = `manager ${tmuxFormatText(input.agent)} · ${tmuxFormatText(input.shortId)}`;
  const ws = input.workspaceName ? ` ${tmuxFormatText(input.workspaceName)}` : '';
  return (
    `#[bg=colour39,fg=colour16] agentbox ▸ #[bold]${label} #[nobold]` +
    `#[${FOOTER_BAR_STYLE}]${ws}#[align=right]${hints} `
  );
}

/**
 * Options set on the manager session only (`-t`, never `-g`): the session lives
 * on the user's own tmux server, whose config is not ours to change.
 *
 * `mouse on` makes the wheel scroll history in copy mode; without it the
 * client's terminal turns the wheel into arrow keys the agent reads as prompt
 * history. `extended-keys` (which would let Ctrl+Enter through with its
 * modifier) is deliberately absent: it is a server option, and a `-t` target
 * does not scope it — tmux silently sets it for every session on the server.
 */
export function managerSessionOptionsArgv(session: string, footer: ManagerFooterInput): string[][] {
  const target = `${exactTarget(session)}:`;
  const set = (name: string, value: string): string[] => ['set-option', '-t', target, name, value];
  return [
    set('mouse', 'on'),
    set('status', 'on'),
    set('status-position', 'bottom'),
    set('status-style', FOOTER_BAR_STYLE),
    set('status-format[0]', managerStatusFormat(footer)),
  ];
}

export interface StartManagerSessionInput {
  wsId: string;
  /** The record to run: a new one for a fresh start, an existing one for a resume. */
  manager: ManagerRecord;
  argv: string[];
  exec?: ManagerExec;
  env?: NodeJS.ProcessEnv;
  /** This machine's hostname, for the registration's `host`. */
  hostname?: () => string;
}

/**
 * Start a manager in a detached tmux session on THIS machine and describe the
 * record it produced. Nothing is written here: the caller persists the
 * registration through its `ManagerRecordStore`, which on a PC with a control
 * box configured is the control box's.
 *
 * The session is the process's home: a client attaches to it instead of the hub
 * proxying a PTY, which is what lets the CLI, the tray and a plain terminal all
 * reach the same running agent.
 */
export async function startManagerSession(
  input: StartManagerSessionInput,
): Promise<ManagerRegistration> {
  const exec = input.exec ?? defaultExec;
  const rec = input.manager;
  const session = managerSessionName(rec.id);
  const exit = managerExitFile(await dirFor(input.wsId), rec.id);
  await mkdir(dirname(exit), { recursive: true });
  // A stale exit code from the previous run would be reported as this run's.
  await rm(exit, { force: true }).catch(() => {});
  const script = buildManagerShellScript({
    argv: input.argv,
    // AGENTBOX_MANAGER carries the id so the agent's own `agentbox` calls are
    // attributed to THIS record rather than registering a second manager.
    env: { AGENTBOX_WORKSPACE: input.wsId, AGENTBOX_MANAGER: rec.id },
    exitFile: exit,
  });
  const workspaceName = await readWorkspace(input.wsId)
    .then((ws) => ws?.name)
    .catch(() => undefined);
  await openManagerTmuxSession({
    session,
    cwd: rec.cwd,
    script,
    footer: {
      agent: rec.agent,
      shortId: (rec.sessionId ?? rec.id).slice(0, 8),
      ...(workspaceName ? { workspaceName } : {}),
    },
    exec,
    ...(input.env ? { env: input.env } : {}),
  });
  return {
    id: rec.id,
    agent: rec.agent,
    kind: 'tmux',
    host: (input.hostname ?? osHostname)(),
    cwd: rec.cwd,
    tmuxSession: session,
    argv: input.argv,
    ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
  };
}

/**
 * A detached tmux session on the user's default server running `script` under
 * their login shell, with the manager session's options (window size, mouse,
 * footer). Shared by a hub-run manager and an attach to a background session.
 */
async function openManagerTmuxSession(input: {
  session: string;
  cwd: string;
  script: string;
  footer: ManagerFooterInput;
  exec: ManagerExec;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { session, exec } = input;
  const env = scrubAgentSessionEnv(input.env ?? process.env);
  await exec(
    'tmux',
    [
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      input.cwd,
      '--',
      loginShell(env),
      '-lc',
      input.script,
    ],
    { env },
  );
  // `latest` sizes the window to the most recently active client, so a tray pane
  // and a terminal attached at once don't clamp the agent's TUI to the lesser
  // grid. It is tmux's own default, but a user config may set `smallest`, and
  // this session is shared by design. `window-size` is a WINDOW option, so the
  // target must be a window (`<session>:` = that session's current window) — a
  // bare session target answers "no such window" and the call is lost.
  // Best-effort: an old tmux without the option must not fail a start that
  // already succeeded.
  await exec(
    'tmux',
    ['set-option', '-w', '-t', `${exactTarget(session)}:`, 'window-size', 'latest'],
    { env },
  ).catch((err: unknown) => {
    // Best-effort, but not silent: swallowing this whole is how a wrong target
    // form shipped once already, invisible to everything but a unit test that
    // could only assert the argv we sent, never what tmux made of it.
    console.warn(
      `[manager] could not pin the tmux window size: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  for (const argv of managerSessionOptionsArgv(session, input.footer)) {
    await exec('tmux', argv, { env }).catch((err: unknown) => {
      console.warn(
        `[manager] could not set tmux ${argv[3] ?? 'option'}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}

/** Every tmux session on the user's default server with the folder it started in; [] without tmux. */
export async function listTmuxSessions(
  exec: ManagerExec = defaultExec,
): Promise<{ session: string; path: string }[]> {
  try {
    const r = await exec('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_path}'], {
      timeout: 3000,
    });
    return (r.stdout ?? '')
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((cols) => cols.length >= 2 && cols[0])
      .map(([session, path]) => ({ session: session!, path: path! }));
  } catch {
    return [];
  }
}

// ── Claude background sessions ──
//
// Claude Code 2.1.270 can host a session in its daemon (`claude --bg`, or a TUI
// that sent its session to the background). `claude agents --json` lists those
// as `kind: "background"` whether or not a client shows them, and nothing it or
// the daemon writes says which client, if any, is attached. The daemon is shared
// and hands the env of the client that spawned it to every session it hosts, so
// neither the session's env nor its process ancestry says either. What the hub
// can see is its own tmux sessions and `claude attach <id>` processes.

/** One row of `claude agents --json` with `kind: "background"`. */
export interface BackgroundSession extends ManagerBackground {
  sessionId: string;
  pid?: number;
  cwd?: string;
}

/** The background rows of `claude agents --json`; anything unparseable is no rows. */
export function parseBackgroundSessions(stdout: string): BackgroundSession[] {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out: BackgroundSession[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    if (row?.['kind'] !== 'background') continue;
    const { id, sessionId, pid, status, state, name, cwd } = row;
    if (typeof id !== 'string' || typeof sessionId !== 'string') continue;
    out.push({
      id,
      sessionId,
      ...(typeof pid === 'number' ? { pid } : {}),
      ...(typeof status === 'string' ? { status } : {}),
      ...(typeof state === 'string' ? { state } : {}),
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof cwd === 'string' ? { cwd } : {}),
    });
  }
  return out;
}

/**
 * Still running in Claude's daemon. Measured on claude 2.1.270: a running
 * session (busy or idle) lists a `pid` and a `status`; one ended with `claude
 * stop`, or one that failed, lists neither while `state` stays `done`/`failed`.
 */
export function isLiveBackgroundSession(s: BackgroundSession): boolean {
  return typeof s.pid === 'number' && s.status !== 'completed';
}

/** `claude attach <id>` in a `ps` command column. */
const ATTACH_CLIENT_RE = /(?:^|\/)claude attach ([A-Za-z0-9_-]+)\s*$/u;

export interface BackgroundSessionSnapshot {
  /** Live background sessions by session id. */
  sessions: Map<string, BackgroundSession>;
  /** The hub's own tmux sessions (`agentbox-manager-*`) and the folder each started in. */
  managerTmux: { session: string; path: string }[];
  /** How many `claude attach <id>` clients run, by short id. */
  attachClients: Map<string, number>;
}

export type BackgroundSessionLookup = (opts?: {
  fresh?: boolean;
}) => Promise<BackgroundSessionSnapshot>;

function emptySnapshot(): BackgroundSessionSnapshot {
  return { sessions: new Map(), managerTmux: [], attachClients: new Map() };
}

/**
 * One snapshot of Claude's background sessions and the hub's tmux sessions,
 * shared by every caller for `ttlMs`: `GET /managers` is polled, so `claude
 * agents --json --all` runs at most once per window with one read in flight, and
 * gives up after `timeoutMs`. `ps` is read only when some session is live. A
 * failed read is empty for the same window; a missing `claude` is not asked again
 * for `missingRetryMs`. `fresh` skips the cache (an attach re-checks before it acts).
 */
export function createBackgroundSessionLookup(
  opts: {
    exec?: ManagerExec;
    ttlMs?: number;
    timeoutMs?: number;
    missingRetryMs?: number;
    now?: () => number;
  } = {},
): BackgroundSessionLookup {
  const exec = opts.exec ?? defaultExec;
  const ttl = opts.ttlMs ?? 15_000;
  const timeout = opts.timeoutMs ?? 3000;
  const missingRetry = opts.missingRetryMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  let cached: { until: number; value: BackgroundSessionSnapshot } | undefined;
  let inflight: Promise<BackgroundSessionSnapshot> | undefined;
  let missingUntil = 0;

  async function readSessions(value: BackgroundSessionSnapshot): Promise<void> {
    if (now() < missingUntil) return;
    try {
      const r = await exec('claude', ['agents', '--json', '--all'], { timeout });
      for (const s of parseBackgroundSessions(r.stdout ?? '')) {
        if (isLiveBackgroundSession(s)) value.sessions.set(s.sessionId, s);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') missingUntil = now() + missingRetry;
    }
  }

  async function read(): Promise<BackgroundSessionSnapshot> {
    const value = emptySnapshot();
    const [, tmux] = await Promise.all([readSessions(value), listTmuxSessions(exec)]);
    value.managerTmux = tmux.filter((t) => MANAGER_SESSION_RE.test(t.session));
    if (value.sessions.size > 0) {
      const ps = await exec('ps', ['-Ao', 'command='], { timeout }).catch(() => ({ stdout: '' }));
      for (const line of (ps.stdout ?? '').split('\n')) {
        const id = ATTACH_CLIENT_RE.exec(line.trim())?.[1];
        if (id) value.attachClients.set(id, (value.attachClients.get(id) ?? 0) + 1);
      }
    }
    cached = { until: now() + ttl, value };
    return value;
  }

  return (o = {}) => {
    if (!o.fresh && cached && now() < cached.until) return Promise.resolve(cached.value);
    inflight ??= read().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
}

/** The daemon session a claude manager's session id names, live or not attachable. */
export function liveBackgroundSession(
  rec: ManagerRecord,
  snap: BackgroundSessionSnapshot,
): BackgroundSession | undefined {
  if (rec.agent !== 'claude' || !rec.sessionId) return undefined;
  return snap.sessions.get(rec.sessionId);
}

/**
 * The manager's session as a DETACHED background session the hub may attach to,
 * or undefined. Detached means live in the daemon and shown by nothing the hub
 * can see: no AgentBox tmux session starts in its folder (a TUI there may be
 * showing it — the single-manager layout's session is exactly that) other than
 * this manager's own attach session, and no `claude attach <id>` client runs
 * outside that attach session. A TUI outside AgentBox's tmux that shows the
 * session cannot be seen, which is why a second client is possible.
 */
export function backgroundFor(
  rec: ManagerRecord,
  snap: BackgroundSessionSnapshot,
): ManagerBackground | undefined {
  const s = liveBackgroundSession(rec, snap);
  if (!s) return undefined;
  const own = managerSessionName(rec.id);
  const ownLive = snap.managerTmux.some((t) => t.session === own);
  const hubSession = rec.kind === 'tmux' ? (rec.tmuxSession ?? own) : undefined;
  // A tmux-run manager whose session is up is shown there, unless that session
  // is the attach this function allowed.
  if (hubSession && hubSession !== own && snap.managerTmux.some((t) => t.session === hubSession)) {
    return undefined;
  }
  const others = snap.managerTmux.filter((t) => t.session !== own && t.path === rec.cwd);
  if (others.length > 0) return undefined;
  const clients = snap.attachClients.get(s.id) ?? 0;
  if (clients > (ownLive ? 1 : 0)) return undefined;
  return {
    id: s.id,
    ...(s.status ? { status: s.status } : {}),
    ...(s.state ? { state: s.state } : {}),
    ...(s.name ? { name: s.name } : {}),
  };
}

/**
 * The one AgentBox tmux session that starts in this manager's folder and that
 * no manager of `claimed` owns — the terminal an external manager was probably
 * started from (the single-manager layout's session is the case this exists
 * for). A guess, so it is only ever offered to a user to open, never adopted.
 */
export function terminalSessionFor(
  rec: ManagerRecord,
  snap: BackgroundSessionSnapshot,
  claimed: ReadonlySet<string>,
): string | undefined {
  const candidates = snap.managerTmux.filter(
    (t) =>
      t.path === rec.cwd && t.session !== managerSessionName(rec.id) && !claimed.has(t.session),
  );
  return candidates.length === 1 ? candidates[0]!.session : undefined;
}

/** The ids `claude attach` takes are short hex; anything else never reaches argv. */
const BACKGROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/**
 * Open a Claude background session in this manager's tmux session (`claude
 * attach <id>`), reusing the session when it already runs. The patch only names
 * that session: the record's kind, session id and pid stay the detected
 * process's, and the agent keeps running in Claude's daemon when this ends.
 */
export async function attachBackgroundSession(input: {
  wsId: string;
  manager: ManagerRecord;
  backgroundId: string;
  exec?: ManagerExec;
  env?: NodeJS.ProcessEnv;
}): Promise<ManagerRecordPatch> {
  const exec = input.exec ?? defaultExec;
  const rec = input.manager;
  if (!BACKGROUND_ID_RE.test(input.backgroundId)) {
    throw new Error(`not a background session id: ${input.backgroundId}`);
  }
  const session = managerSessionName(rec.id);
  if (!(await tmuxSessionExists(session, exec))) {
    const workspaceName = await readWorkspace(input.wsId)
      .then((ws) => ws?.name)
      .catch(() => undefined);
    await openManagerTmuxSession({
      session,
      cwd: rec.cwd,
      script: `${unsetAgentSessionEnv()}; exec ${shellJoin(['claude', 'attach', input.backgroundId])}`,
      footer: {
        agent: rec.agent,
        shortId: (rec.sessionId ?? rec.id).slice(0, 8),
        ...(workspaceName ? { workspaceName } : {}),
      },
      exec,
      ...(input.env ? { env: input.env } : {}),
    });
  }
  return { tmuxSession: session };
}

/**
 * End the hub's attach session for a manager whose session runs in Claude's
 * daemon. Only the attach client goes: the background session keeps running.
 */
export async function detachBackgroundSession(
  rec: ManagerRecord,
  exec: ManagerExec = defaultExec,
): Promise<ManagerRecordPatch | null> {
  const session = managerSessionName(rec.id);
  await exec('tmux', ['kill-session', '-t', exactTarget(session)]).catch(() => {});
  if (rec.tmuxSession !== session || rec.kind === 'tmux') return null;
  return { tmuxSession: null };
}

/**
 * Reopen a manager's session in the hub's tmux with the agent's own resume
 * spelling. Refused while the session is still running anywhere: two processes
 * writing one transcript corrupt it.
 */
export async function resumeManagerSession(
  rec: ManagerRecord,
  probe: ManagerProbe & { env?: NodeJS.ProcessEnv } = {},
  opts: { prompt?: string } = {},
): Promise<ManagerRegistration> {
  const id = rec.id;
  const host = (probe.hostname ?? osHostname)();
  if (ranElsewhere(rec, host)) {
    throw new ManagerConflictError(
      `manager ${id} runs on ${rec.host}; its transcript is not on this machine (${host}), so it cannot be resumed here`,
    );
  }
  if ((await managerStatus(rec, probe)) === 'running') {
    throw new ManagerConflictError(
      rec.kind === 'external'
        ? `manager ${id} is still running in a terminal${rec.pid !== undefined ? ` (pid ${String(rec.pid)})` : ''}; exit it there before resuming it here`
        : `manager ${id} is already running; attach to it instead`,
    );
  }
  if (!rec.sessionId) {
    throw new ManagerConflictError(
      `manager ${id} has no session id to resume; start a new manager instead`,
    );
  }
  if (!isResumableManagerAgent(rec.agent)) {
    throw new ManagerConflictError(
      `session resume is only supported for ${RESUMABLE_MANAGER_AGENTS.join(', ')}, not ${rec.agent}`,
    );
  }
  return startManagerSession({
    wsId: rec.workspaceId,
    manager: rec,
    argv: buildManagerArgv(rec.agent, rec.sessionId, opts.prompt),
    ...(probe.hostname ? { hostname: probe.hostname } : {}),
    ...(probe.exec ? { exec: probe.exec } : {}),
    ...(probe.env ? { env: probe.env } : {}),
  });
}

/** Where to type into a running manager: the hub's own session, or a detected terminal pane. */
export type ManagerKeysTarget = { session: string } | { pane: string };

/** `%<n>`, the only shape `$TMUX_PANE` takes. */
export const TMUX_PANE_RE = /^%\d+$/u;

/**
 * The agent TUIs treat a key burst ending in Enter as one paste and keep the
 * Enter as a newline inside it. A pause between the text and the Enter makes the
 * Enter a separate keypress, which submits.
 */
const SUBMIT_DELAY_MS = 400;

/**
 * The `send-keys -l` argv that types `text` verbatim. `--` keeps a leading `-`
 * from parsing as a flag, and a trailing `;` is escaped because tmux reads an
 * argument ending in `;` as a command separator and drops it.
 */
export function sendKeysLiteralArgv(target: string, text: string): string[] {
  const flat = text.replace(/\s*[\r\n]+\s*/gu, ' ').trim();
  const literal = flat.endsWith(';') ? `${flat.slice(0, -1)}\\;` : flat;
  return ['send-keys', '-t', target, '-l', '--', literal];
}

/**
 * Type `text` into a running manager and submit it. Newlines are flattened: each
 * one would reach the agent as Enter and submit a fragment.
 */
export async function sendKeysToManager(
  target: ManagerKeysTarget,
  text: string,
  exec: ManagerExec = defaultExec,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const t = 'session' in target ? `${exactTarget(target.session)}:` : target.pane;
  if ('pane' in target && !TMUX_PANE_RE.test(target.pane)) {
    throw new Error(`not a tmux pane id: ${target.pane}`);
  }
  await exec('tmux', sendKeysLiteralArgv(t, text));
  await sleep(SUBMIT_DELAY_MS);
  await exec('tmux', ['send-keys', '-t', t, 'Enter']);
}

/**
 * Kill a tmux-run manager's session and describe the record change. Idempotent:
 * a session that is already gone is fine, and the record is kept so it can be
 * resumed. An external manager is the user's own process, which the hub does not
 * signal — `null` says there is nothing to persist.
 */
export async function stopManagerSession(
  rec: ManagerRecord,
  probe: ManagerProbe = {},
): Promise<ManagerRecordPatch | null> {
  if (rec.kind === 'external') {
    if ((await managerStatus(rec, probe)) === 'running') {
      throw new ManagerConflictError(
        `manager ${rec.id} runs in your terminal; the hub does not stop a process it did not start`,
      );
    }
    return null;
  }
  const exec = probe.exec ?? defaultExec;
  const session = rec.tmuxSession ?? managerSessionName(rec.id);
  await exec('tmux', ['kill-session', '-t', exactTarget(session)]).catch(() => {});
  const lastExit = await readManagerExit(rec.workspaceId, rec.id);
  return {
    stoppedAt: new Date().toISOString(),
    ...(lastExit === undefined ? {} : { lastExit }),
  };
}

// ── session turns ──

export interface SessionTurn {
  /** 1-based count of user turns so far. */
  turn: number;
  /** The latest turn's prompt, as a one-line title; absent when none was readable. */
  prompt?: string;
}

interface TurnCache {
  ino: number;
  offset: number;
  turns: number;
  lastPrompt?: string;
  promptIds: Set<string>;
}

/** Keyed by transcript path. Each call reads only the bytes appended since the last. */
const turnCaches = new Map<string, TurnCache>();
/** The read in flight per transcript path; the next caller waits for it. */
const turnReads = new Map<string, Promise<SessionTurn | undefined>>();
/** A codex session's rollout file, once found: the store is flat and walking it is not free. */
const rolloutPaths = new Map<string, string>();
const TURN_READ_CHUNK = 4 * 1024 * 1024;

/** A claude `user` row that is a turn the human (or a harness) typed, not a tool result. */
function claudeTurnRow(row: unknown): { promptId?: string; prompt: string | null } | null {
  const rec = row as {
    type?: string;
    isMeta?: boolean;
    isSidechain?: boolean;
    promptId?: unknown;
    message?: { content?: unknown };
  };
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return null;
  const content = rec.message?.content;
  if (Array.isArray(content)) {
    const blocks = content as { type?: string }[];
    if (blocks.length === 0 || blocks.every((b) => b?.type === 'tool_result')) return null;
  } else if (typeof content !== 'string') {
    return null;
  }
  const text = firstTextBlock(content);
  return {
    ...(typeof rec.promptId === 'string' ? { promptId: rec.promptId } : {}),
    prompt: text === null ? null : asTitle(text),
  };
}

function absorbTurnLine(agent: string, cache: TurnCache, line: string): void {
  if (agent === 'claude') {
    if (!line.includes('"user"')) return;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    const hit = claudeTurnRow(row);
    if (!hit) return;
    if (hit.promptId !== undefined) {
      if (cache.promptIds.has(hit.promptId)) return;
      cache.promptIds.add(hit.promptId);
    } else if (hit.prompt === null) {
      // No prompt id and nothing typed: a command wrapper (`/clear`), not a turn.
      return;
    }
    cache.turns += 1;
    if (hit.prompt) cache.lastPrompt = hit.prompt;
    return;
  }
  if (!line.includes('turn_context') && !line.includes('user_message')) return;
  let rec: { type?: string; payload?: { type?: string; message?: unknown } };
  try {
    rec = JSON.parse(line) as typeof rec;
  } catch {
    return;
  }
  if (rec.type === 'turn_context') cache.turns += 1;
  else if (
    rec.type === 'event_msg' &&
    rec.payload?.type === 'user_message' &&
    typeof rec.payload.message === 'string'
  ) {
    const prompt = asTitle(rec.payload.message);
    if (prompt) cache.lastPrompt = prompt;
  }
}

async function transcriptFor(
  agent: string,
  cwd: string,
  sessionId: string,
  home: string,
): Promise<string | null> {
  if (agent === 'claude') {
    return join(home, '.claude', 'projects', encodeClaudeProjectsKey(cwd), `${sessionId}.jsonl`);
  }
  if (agent !== 'codex') return null;
  const known = rolloutPaths.get(sessionId);
  if (known && (await stat(known).catch(() => null))) return known;
  const hit = (await findRolloutFiles(join(home, '.codex', 'sessions'))).find(
    (f) => f.id === sessionId,
  );
  if (!hit) return null;
  rolloutPaths.set(sessionId, hit.file);
  return hit.file;
}

/**
 * Which turn a session is on, and what that turn asked, read from the agent's
 * own transcript. `undefined` when the transcript is not readable here or has no
 * turn yet.
 *
 * - claude: a turn is a new `promptId` on a `user` row that is neither meta nor
 *   tool results only (rows without a prompt id count when they carry typed text).
 * - codex: a turn is a `turn_context` row; the prompt is the last `user_message`.
 */
export async function sessionTurn(
  agent: string,
  cwd: string,
  sessionId: string,
  home: string = homedir(),
): Promise<SessionTurn | undefined> {
  const file = await transcriptFor(agent, cwd, sessionId, home);
  if (!file) return undefined;
  // Two readers of one transcript would both absorb the bytes past the shared
  // offset and count every turn in them twice.
  const prev = turnReads.get(file) ?? Promise.resolve(undefined);
  const next = prev.then(
    () => readSessionTurn(agent, file),
    () => readSessionTurn(agent, file),
  );
  turnReads.set(file, next);
  try {
    return await next;
  } finally {
    if (turnReads.get(file) === next) turnReads.delete(file);
  }
}

async function readSessionTurn(agent: string, file: string): Promise<SessionTurn | undefined> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    turnCaches.delete(file);
    return undefined;
  }
  try {
    const st = await fh.stat();
    let cache = turnCaches.get(file);
    if (!cache || cache.ino !== st.ino || st.size < cache.offset) {
      cache = { ino: st.ino, offset: 0, turns: 0, promptIds: new Set() };
      turnCaches.set(file, cache);
    }
    let tail = '';
    let pos = cache.offset;
    const chunk = Buffer.alloc(Math.min(TURN_READ_CHUNK, Math.max(1, st.size - cache.offset)));
    while (pos < st.size) {
      const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, st.size - pos), pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const text = tail + chunk.subarray(0, bytesRead).toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end === -1) {
        tail = text;
        continue;
      }
      for (const line of text.slice(0, end).split('\n')) absorbTurnLine(agent, cache, line);
      tail = text.slice(end + 1);
    }
    // A partial last line is left for the next call to read whole.
    cache.offset = pos - Buffer.byteLength(tail, 'utf8');
    if (cache.turns === 0) return undefined;
    return { turn: cache.turns, ...(cache.lastPrompt ? { prompt: cache.lastPrompt } : {}) };
  } catch {
    return undefined;
  } finally {
    await fh.close();
  }
}

/**
 * The session's title from the agent's own store, or `null` when it cannot be
 * read here (a session on another machine, or an agent whose store we do not read).
 */
export async function sessionTitle(
  agent: string,
  cwd: string,
  sessionId: string,
  home: string = homedir(),
): Promise<string | null> {
  if (agent === 'claude') {
    const file = join(
      home,
      '.claude',
      'projects',
      encodeClaudeProjectsKey(cwd),
      `${sessionId}.jsonl`,
    );
    const head = await readHead(file, SESSION_HEAD_BYTES);
    return head === null ? null : titleFromTranscript(head);
  }
  if (agent === 'codex') {
    const indexed = (await readThreadNames(join(home, '.codex', 'session_index.jsonl'))).get(
      sessionId,
    );
    const title = indexed === undefined ? null : asTitle(indexed, { skipSlash: true });
    if (title) return title;
    const listed = await listRolloutSessions(cwd, agent, home);
    return listed.find((s) => s.id === sessionId)?.title ?? null;
  }
  return null;
}

/** Read at most `bytes` from the start of a file; `null` when it cannot be read. */
/**
 * The file's first line, however long it is (bounded against a pathological one).
 * Reading a fixed head instead would silently drop every session whose opening
 * record outgrew the buffer, and that record is the only place the folder is
 * recorded.
 */
async function readFirstLine(file: string): Promise<string | null> {
  try {
    const fh = await open(file, 'r');
    try {
      const chunk = Buffer.alloc(64 * 1024);
      let text = '';
      let pos = 0;
      while (pos < SESSION_FIRST_LINE_MAX) {
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
        if (bytesRead === 0) return text;
        pos += bytesRead;
        text += chunk.subarray(0, bytesRead).toString('utf8');
        const nl = text.indexOf('\n');
        if (nl !== -1) return text.slice(0, nl);
      }
      return null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** The LAST `bytes` of a file, with any partial leading line dropped. */
async function readTail(file: string, bytes: number): Promise<string | null> {
  try {
    const fh = await open(file, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      if (start === 0) return text;
      const nl = text.indexOf('\n');
      return nl === -1 ? '' : text.slice(nl + 1);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function readHead(file: string, bytes: number, start = 0): Promise<string | null> {
  try {
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, start);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * One line of text, trimmed to a title. `null` when it is not usable as one.
 *
 * `skipSlash` is for a name the agent DERIVED from a turn: a session whose first
 * turn was `/clear` is indexed under that literal, which names nothing.
 */
function asTitle(
  text: string,
  opts: { skipSlash?: boolean; skipInjected?: boolean } = {},
): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  // Command wrappers and system reminders are not what the user typed.
  if (!flat || flat.startsWith('<')) return null;
  if (opts.skipSlash && flat.startsWith('/')) return null;
  if (opts.skipInjected && isInjectedContext(flat)) return null;
  return flat.length > SESSION_TITLE_MAX ? `${flat.slice(0, SESSION_TITLE_MAX - 1)}…` : flat;
}

/**
 * Context an agent injects as if the user had typed it.
 *
 * A rollout's early `role: 'user'` records are not all turns: the repo's
 * instructions file and the harness's own preambles arrive the same way, so
 * scraping blindly names every session in a repo after its AGENTS.md. Measured
 * on a real store: 8 of 8 sessions in one folder shared one assessor preamble.
 */
function isInjectedContext(flat: string): boolean {
  if (flat.startsWith('#')) return true;
  return INJECTED_PREFIXES.some((p) => flat.startsWith(p));
}

const INJECTED_PREFIXES = [
  'The following is the',
  'AGENTS.md',
  'You are ',
  'Caveat:',
  'This session is being continued',
];

/** The first `text` block of a content array, whatever the block type is called. */
function firstTextBlock(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const { text } = block as { text?: unknown };
    if (typeof text === 'string' && text) return text;
  }
  return null;
}

/** Parse a JSONL head line by line; a truncated last line is expected. */
function* jsonlRows(head: string): Generator<unknown> {
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      continue;
    }
  }
}

/** First user turn of a claude transcript, as a one-line title. */
function titleFromTranscript(head: string): string {
  for (const row of jsonlRows(head)) {
    const rec = row as { type?: string; message?: { content?: unknown } };
    if (rec.type !== 'user') continue;
    const text = firstTextBlock(rec.message?.content);
    const title = text === null ? null : asTitle(text, { skipInjected: true });
    if (title) return title;
  }
  return UNTITLED_SESSION;
}

/**
 * First user turn of a rollout transcript, as a one-line title.
 *
 * A rollout records turns as `response_item` envelopes carrying an OpenAI-shaped
 * message (`payload.role`, `payload.content[].text`), and older writers emit an
 * `event_msg` / `user_message` instead — both are read here because a session
 * listing that silently shows "(untitled)" is indistinguishable from a bug.
 *
 * Both record shapes are accepted because the store mixes writers across agent
 * versions; only the `role: 'user'` form appears in a store written by a current
 * one, so the other branch is a compatibility path, not the common case.
 */
function titleFromRollout(head: string): string {
  for (const row of jsonlRows(head)) {
    const rec = row as {
      payload?: { type?: string; role?: string; content?: unknown; message?: unknown };
    };
    const payload = rec.payload;
    if (!payload) continue;
    let text: string | null = null;
    if (payload.role === 'user') text = firstTextBlock(payload.content);
    else if (payload.type === 'user_message' && typeof payload.message === 'string') {
      text = payload.message;
    }
    const title = text === null ? null : asTitle(text, { skipInjected: true });
    if (title) return title;
  }
  return UNTITLED_SESSION;
}

/** Claude's store: one folder per project, one `<uuid>.jsonl` per session. */
async function listProjectTranscripts(
  root: string,
  agent: string,
  home: string,
): Promise<HostSession[]> {
  const dir = join(home, '.claude', 'projects', encodeClaudeProjectsKey(root));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const rows: { session: HostSession; mtime: number }[] = [];
  for (const name of names) {
    // `agent-*.jsonl` are subagent transcripts; they are not resumable sessions.
    if (!name.endsWith('.jsonl') || name.startsWith('agent-')) continue;
    const file = join(dir, name);
    let mtime: number;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    const head = await readHead(file, SESSION_HEAD_BYTES);
    if (head === null) continue;
    rows.push({
      session: {
        id: basename(name, '.jsonl'),
        agent,
        title: titleFromTranscript(head),
        updatedAt: new Date(mtime).toISOString(),
      },
      mtime,
    });
  }
  return sortAndCap(rows);
}

/**
 * The rollout store: `<home>/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`,
 * FLAT across every project — the folder a session ran in is not in its path, so
 * it has to be read out of each file's first record.
 *
 * Ported from `packages/agent-codex/src/cli/teleport.ts` rather than imported:
 * `@agentbox/relay` does not depend on an agent package (and must not — the hub
 * loads no agent modules), and this is three small functions.
 */
async function listRolloutSessions(
  root: string,
  agent: string,
  home: string,
): Promise<HostSession[]> {
  const candidates = await rolloutCandidates(join(home, '.codex', 'sessions'));
  if (candidates.length === 0) return [];
  const wanted = await canonicalPath(root);
  const titles = await readThreadNames(join(home, '.codex', 'session_index.jsonl'));
  const rows: { session: HostSession; mtime: number }[] = [];
  for (const { file, id, mtime } of candidates) {
    const first = await readFirstLine(file);
    if (first === null) continue;
    const cwd = cwdFromRollout(first);
    if (cwd === null) continue;
    if (cwd !== root && (await canonicalPath(cwd)) !== wanted) continue;
    const indexed = titles.get(id);
    // Scrape AFTER the opening record: it alone can be hundreds of kilobytes, so
    // a head read from byte zero would spend its whole budget on the metadata and
    // never reach a turn. `first` is already in hand and holds no user text.
    const indexedTitle = indexed === undefined ? null : asTitle(indexed, { skipSlash: true });
    const title =
      indexedTitle ??
      titleFromRollout(
        (await readHead(file, SESSION_HEAD_BYTES, Buffer.byteLength(first, 'utf8') + 1)) ?? '',
      );
    rows.push({
      session: { id, agent, title, updatedAt: new Date(mtime).toISOString() },
      mtime,
    });
  }
  return sortAndCap(rows);
}

/**
 * Every rollout in the store, newest-ACTIVITY first and capped.
 *
 * Ranking by mtime before the cap is what makes the cap honest: the filename
 * carries creation time, but a resumed session keeps appending to its original
 * file, so a name-ordered cut drops the sessions someone is still working in.
 */
async function rolloutCandidates(
  sessionsRoot: string,
): Promise<{ file: string; id: string; mtime: number }[]> {
  const files = await findRolloutFiles(sessionsRoot);
  const dated: { file: string; id: string; mtime: number }[] = [];
  for (const { file, id } of files) {
    try {
      dated.push({ file, id, mtime: (await stat(file)).mtimeMs });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  dated.sort((a, b) => b.mtime - a.mtime);
  return dated.slice(0, ROLLOUT_SCAN_MAX);
}

function sortAndCap(rows: { session: HostSession; mtime: number }[]): HostSession[] {
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, SESSION_LIST_MAX).map((r) => r.session);
}

/** Resolve symlinks so `/tmp/x` and `/private/tmp/x` compare equal; the raw path on failure. */
async function canonicalPath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * The three fixed levels of the rollout store, newest-first and bounded.
 *
 * No recursion and no globbing: the depth is part of the format. Names sort
 * chronologically at every level (`YYYY`, `MM`, `DD`, then a timestamped
 * filename), so descending order visits the most recently CREATED sessions
 * first. That is not the same as most recently used, which is why the caller
 * ranks by mtime before applying the read budget.
 */
async function findRolloutFiles(sessionsRoot: string): Promise<{ file: string; id: string }[]> {
  const out: { file: string; id: string }[] = [];
  const desc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);
  for (const y of (await safeReaddir(sessionsRoot)).filter((n) => /^\d{4}$/u.test(n)).sort(desc)) {
    const yDir = join(sessionsRoot, y);
    for (const m of (await safeReaddir(yDir)).filter((n) => /^\d{2}$/u.test(n)).sort(desc)) {
      const mDir = join(yDir, m);
      for (const d of (await safeReaddir(mDir)).filter((n) => /^\d{2}$/u.test(n)).sort(desc)) {
        const dDir = join(mDir, d);
        for (const name of (await safeReaddir(dDir)).sort(desc)) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
          const id = ROLLOUT_UUID_RE.exec(name)?.[1];
          if (id === undefined) continue;
          out.push({ file: join(dDir, name), id });
          if (out.length >= ROLLOUT_STAT_MAX) return out;
        }
      }
    }
  }
  return out;
}

/**
 * The folder a rollout ran in, from its opening record — and `null` for a
 * session no human started.
 *
 * The store holds the agent's own internal threads alongside real ones: a
 * `guardian_review` thread assessing a command, a `subagent` thread doing part
 * of a task. On one real store those were 49 of 71 files. They have no user turn
 * to name them and resuming one puts the user inside the agent's plumbing, so
 * they are skipped here exactly as claude's `agent-*.jsonl` transcripts are.
 * An absent marker means a writer too old to record one: kept, not guessed at.
 */
function cwdFromRollout(head: string): string | null {
  const nl = head.indexOf('\n');
  const first = nl === -1 ? head : head.slice(0, nl);
  try {
    const parsed = JSON.parse(first) as {
      type?: string;
      payload?: { cwd?: unknown; thread_source?: unknown };
    };
    if (parsed.type !== 'session_meta' || typeof parsed.payload?.cwd !== 'string') return null;
    const source = parsed.payload.thread_source;
    if (typeof source === 'string' && source !== 'user') return null;
    return parsed.payload.cwd;
  } catch {
    /* not a session_meta line: treat the file as unattributable */
  }
  return null;
}

/** `{id, thread_name}` rows the agent maintains next to its rollouts, if any. */
async function readThreadNames(file: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const tail = await readTail(file, SESSION_INDEX_BYTES);
  if (tail === null) return out;
  for (const row of jsonlRows(tail)) {
    const rec = row as { id?: unknown; thread_name?: unknown };
    if (typeof rec.id === 'string' && typeof rec.thread_name === 'string') {
      out.set(rec.id, rec.thread_name);
    }
  }
  return out;
}

/**
 * Resumable agent sessions for a folder, read from the agent's OWN store — the
 * manager picker offers "continue where you left off" without the agent running.
 *
 * Only the agents in `RESUMABLE_MANAGER_AGENTS` are read; the others' on-disk
 * session formats are not verified, and offering a session we cannot actually
 * resume is worse than offering none.
 */
export async function listResumableHostSessions(
  root: string,
  agent: string = DEFAULT_RESUMABLE_AGENT,
  home: string = homedir(),
): Promise<{ agent: string; supported: boolean; sessions: HostSession[] }> {
  if (!isResumableManagerAgent(agent)) return { agent, supported: false, sessions: [] };
  const sessions =
    agent === 'codex'
      ? await listRolloutSessions(root, agent, home)
      : await listProjectTranscripts(root, agent, home);
  return { agent, supported: true, sessions };
}
