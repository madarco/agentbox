/**
 * Which host agent session this CLI invocation is running inside, if any.
 *
 * A manager is not declared: it is the claude or codex session in the user's
 * terminal that shells out to `agentbox`. Each agent exports its identity into
 * the commands it runs, so the CLI can name the session and the hub can register
 * it — and group the boxes that session creates under it.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { log } from '@agentbox/cli-kit';
import { encodeClaudeProjectsKey } from '@agentbox/sandbox-core';
import type { AgentId } from '@agentbox/core';
import { HubApiError } from '../control-plane/hub-api-client.js';
import { scanWorkspace } from './workspace-scan.js';
import type {
  HubApiClient,
  HubApiManagerDetect,
  HubApiWorkspace,
} from '../control-plane/hub-api-client.js';

/** Identity env vars each agent exports into the shell of the commands it runs,
 *  so a bare `agentbox fork` (no --agent) can tell which agent launched it:
 *  - claude: CLAUDECODE=1 and CLAUDE_CODE_SESSION_ID=<session uuid>.
 *  - codex: CODEX_THREAD_ID=<session uuid> (the id `codex resume` expects).
 *  Returns undefined when neither is present (caller falls back to claude).
 *  Keep it pure (env in, agent out, no fs). */
export function detectAgentFromEnv(env: NodeJS.ProcessEnv = process.env): AgentId | undefined {
  if (env.CLAUDECODE === '1' || (env.CLAUDE_CODE_SESSION_ID ?? '').trim().length > 0) {
    return 'claude';
  }
  if ((env.CODEX_THREAD_ID ?? '').trim().length > 0) return 'codex';
  return undefined;
}

/** Two sessions in one folder both touched inside this window means a guess would be a coin flip. */
export const RECENT_SESSION_MS = 5 * 60 * 1000;

/** The shape both agent stores use for a session id, and the only one the hub accepts. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MANAGER_ID_RE = /^[0-9a-f]{16}$/;
const TMUX_PANE_RE = /^%\d+$/;

/** A transcript's opening rows carry the session's cwd well inside this. */
const TRANSCRIPT_HEAD_BYTES = 64 * 1024;

function defaultReadHead(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The `cwd` a claude transcript records on its rows; the folder name is a lossy encoding of it. */
export function cwdFromTranscriptHead(head: string): string | undefined {
  for (const line of head.split('\n')) {
    if (!line.includes('"cwd"')) continue;
    try {
      const row = JSON.parse(line) as { cwd?: unknown };
      if (typeof row.cwd === 'string' && row.cwd.startsWith('/')) return row.cwd;
    } catch {
      // A row cut by the head boundary; the next one may be whole.
    }
  }
  return undefined;
}

/** Bound on the ancestor walk; a real process tree is a handful of hops. */
const MAX_PARENT_HOPS = 20;
/** Total budget for every `ps` call in one walk. */
const PS_BUDGET_MS = 1000;

export interface HostSessionHint {
  /** claude or codex today: the only agents that export a session id. */
  agent: AgentId;
  sessionId: string;
  /** The folder the session runs in — where `--resume` finds its transcript. */
  cwd: string;
  pid?: number;
  host: string;
  /** Set inside a hub-run manager's own session. */
  managerId?: string;
  /** `$TMUX_PANE` when the session's terminal runs inside tmux: where the hub can type to it. */
  tmuxPane?: string;
  /** The AgentBox manager tmux session (`agentbox-manager-*`) that pane belongs to. */
  tmuxSession?: string;
}

export interface HostSessionDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  hostname?: () => string;
  exists?: (path: string) => boolean;
  listDir?: (dir: string) => string[];
  mtimeMs?: (path: string) => number | undefined;
  /** The first bytes of a file as text, or undefined when it cannot be read. */
  readHead?: (path: string) => string | undefined;
  /** `{ppid, comm}` of a process, or undefined when it cannot be read. */
  ps?: (pid: number, timeoutMs: number) => { ppid: number; comm: string } | undefined;
  ppid?: number;
  now?: () => number;
  /** Skip the ancestor walk that finds codex's pid: a caller that only names the session. */
  pidless?: boolean;
  /** The name of the tmux session a pane belongs to, or undefined when tmux cannot say. */
  tmuxSessionOf?: (pane: string, timeoutMs: number) => string | undefined;
}

const MANAGER_TMUX_SESSION_RE = /^agentbox-manager-[0-9a-f]{16}$/;

function defaultTmuxSessionOf(pane: string, timeoutMs: number): string | undefined {
  try {
    const r = spawnSync('tmux', ['display-message', '-p', '-t', pane, '#{session_name}'], {
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    return r.status === 0 ? r.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

function defaultPs(pid: number, timeoutMs: number): { ppid: number; comm: string } | undefined {
  // Fail soft on every path: inside codex's default sandbox `ps` is "operation
  // not permitted", and a manager without a pid is still a manager.
  try {
    const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.error || r.status !== 0) return undefined;
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(r.stdout.trim());
    return m ? { ppid: Number(m[1]), comm: m[2]! } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pid of the nearest ancestor named `codex`. Codex exports no pid variable,
 * but the commands it runs are its descendants.
 */
export function findAncestorPid(
  name: string,
  startPid: number,
  ps: NonNullable<HostSessionDeps['ps']>,
  now: () => number = Date.now,
): number | undefined {
  return findNearestAncestor([name], startPid, ps, now)?.pid;
}

/** The nearest ancestor whose process name is one of `names`. */
export function findNearestAncestor(
  names: readonly string[],
  startPid: number,
  ps: NonNullable<HostSessionDeps['ps']>,
  now: () => number = Date.now,
): { pid: number; name: string } | undefined {
  const deadline = now() + PS_BUDGET_MS;
  let pid = startPid;
  for (let hop = 0; hop < MAX_PARENT_HOPS && pid > 1; hop++) {
    const left = deadline - now();
    if (left <= 0) return undefined;
    const row = ps(pid, left);
    if (!row) return undefined;
    const name = basename(row.comm);
    if (names.includes(name)) return { pid, name };
    pid = row.ppid;
  }
  return undefined;
}

function parsePid(raw: string | undefined): number | undefined {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isInteger(n) && n > 1 ? n : undefined;
}

/**
 * The host agent session this process runs in, or undefined when there is none
 * we can name with confidence.
 *
 * claude: `CLAUDE_CODE_SESSION_ID` is cross-checked against a transcript. Inside
 * an Agent-tool subagent that id is the subagent's own, with no transcript; the
 * fallback is the newest session in the folder, but only when exactly one was
 * touched in the last five minutes. The folder is walked upward, because the
 * command may run in a subfolder of the one the session was started in — and a
 * resume has to run in THAT one.
 */
export function detectHostSession(deps: HostSessionDeps = {}): HostSessionHint | undefined {
  const env = deps.env ?? process.env;
  // Inside a box: that agent is not a host session, and the hub it would register
  // with is the box's relay view of the host, not a terminal the user sits at.
  if ((env['AGENTBOX_RELAY_URL'] ?? '').trim().length > 0) return undefined;
  let agent = detectAgentFromEnv(env);
  if (!agent) return undefined;
  if (agent === 'claude' && (env['CODEX_THREAD_ID'] ?? '').trim().length > 0) {
    // Both set: one agent runs inside the other and inherited the outer one's
    // variables, so the nearest ancestor is the one issuing this command. A `ps`
    // that is refused means codex's sandbox, which claude does not impose.
    const nearest = findNearestAncestor(
      ['claude', 'codex'],
      deps.ppid ?? process.ppid,
      deps.ps ?? defaultPs,
      deps.now,
    );
    agent = nearest?.name === 'claude' ? 'claude' : 'codex';
  }
  const cwd = deps.cwd ?? process.cwd();
  const host = (deps.hostname ?? hostname)();
  const hint = env['AGENTBOX_MANAGER']?.trim();
  const managerId = hint && MANAGER_ID_RE.test(hint) ? hint : undefined;
  // TMUX_PANE alone can be inherited stale by a process outside tmux; TMUX says it is live.
  const pane = (env['TMUX'] ?? '').length > 0 ? env['TMUX_PANE']?.trim() : undefined;
  const livePane = pane && TMUX_PANE_RE.test(pane) ? pane : undefined;
  // Only an AgentBox manager session is worth naming: the hub runs the manager
  // from it. A session hosted by Claude's background daemon never gets here, since
  // the daemon drops TMUX. Skipped with the pid walk, for the same cheap callers.
  const session =
    livePane && !deps.pidless
      ? (deps.tmuxSessionOf ?? defaultTmuxSessionOf)(livePane, 1000)
      : undefined;
  const base = {
    host,
    ...(managerId ? { managerId } : {}),
    ...(livePane ? { tmuxPane: livePane } : {}),
    ...(session && MANAGER_TMUX_SESSION_RE.test(session) ? { tmuxSession: session } : {}),
  };

  if (agent === 'codex') {
    const sessionId = (env['CODEX_THREAD_ID'] ?? '').trim();
    if (!SESSION_ID_RE.test(sessionId)) return undefined;
    const pid = deps.pidless
      ? undefined
      : findAncestorPid('codex', deps.ppid ?? process.ppid, deps.ps ?? defaultPs, deps.now);
    return { agent: 'codex', sessionId, cwd, ...base, ...(pid !== undefined ? { pid } : {}) };
  }

  const exists = deps.exists ?? existsSync;
  const home = deps.home ?? homedir();
  const projectDir = (dir: string): string =>
    join(home, '.claude', 'projects', encodeClaudeProjectsKey(dir));
  const pid = parsePid(env['CLAUDE_PID']);
  const withPid = pid !== undefined ? { pid } : {};

  const listDir =
    deps.listDir ??
    ((dir: string): string[] => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    });
  const mtimeMs =
    deps.mtimeMs ??
    ((p: string): number | undefined => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return undefined;
      }
    });
  const envId = (env['CLAUDE_CODE_SESSION_ID'] ?? '').trim();
  if (SESSION_ID_RE.test(envId)) {
    for (let dir = cwd; ; dir = dirname(dir)) {
      if (exists(join(projectDir(dir), `${envId}.jsonl`))) {
        return { agent: 'claude', sessionId: envId, cwd: dir, ...base, ...withPid };
      }
      if (dirname(dir) === dir) break;
    }
    // The session may have been started anywhere: the command can `cd` to a sibling
    // project before it runs agentbox. The transcript's own rows say where.
    const projectsRoot = join(home, '.claude', 'projects');
    for (const key of listDir(projectsRoot)) {
      const file = join(projectsRoot, key, `${envId}.jsonl`);
      if (!exists(file)) continue;
      const head = (deps.readHead ?? defaultReadHead)(file);
      const sessionCwd = head ? cwdFromTranscriptHead(head) : undefined;
      if (sessionCwd)
        return { agent: 'claude', sessionId: envId, cwd: sessionCwd, ...base, ...withPid };
    }
  }

  const now = (deps.now ?? Date.now)();
  const dir = projectDir(cwd);
  const recent = listDir(dir)
    .filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'))
    .filter((f) => {
      const m = mtimeMs(join(dir, f));
      return m !== undefined && now - m < RECENT_SESSION_MS;
    });
  if (recent.length !== 1) return undefined;
  const sessionId = basename(recent[0]!, '.jsonl');
  if (!SESSION_ID_RE.test(sessionId)) return undefined;
  return { agent: 'claude', sessionId, cwd, ...base, ...withPid };
}

export interface RegisteredManager {
  managerId: string;
  workspace: HubApiWorkspace;
}

/**
 * Register the session with the hub. Never fails the caller: a manager is
 * bookkeeping around a create or a task, and losing it is a warning.
 */
export async function registerHostManager(
  client: Pick<HubApiClient, 'detectManager'>,
  hint: HostSessionHint,
  attach?: { boxId: string } | { boxJobId: string },
): Promise<RegisteredManager | undefined> {
  try {
    // The scan and `$HOME` ride along: when no workspace contains this folder the
    // hub registers one, and it cannot see (or stat) a folder on this machine.
    const scan = await scanWorkspace(hint.cwd).catch(() => undefined);
    const body: HubApiManagerDetect = {
      ...hint,
      ...(attach ?? {}),
      ...(scan ? { projects: scan.projects } : {}),
      home: homedir(),
    };
    const res = await client.detectManager(body);
    return { managerId: res.manager.id, workspace: res.workspace };
  } catch (err) {
    if (err instanceof HubApiError && err.code === 'invalid_request') {
      // The hub refused the folder (the home folder, or one it does not have).
      log.warn(`this ${hint.agent} session was not registered as a manager: ${err.message}`);
      return undefined;
    }
    log.warn(
      `could not register this ${hint.agent} session as a manager: ${err instanceof Error ? err.message : String(err)}` +
        (hint.agent === 'codex'
          ? ' (inside the codex sandbox the hub is unreachable unless sandbox_workspace_write.network_access is on)'
          : ''),
    );
    return undefined;
  }
}

/** Detect and register in one step; undefined outside a host agent session. */
export async function registerCurrentSession(
  client: HubApiClient,
  attach?: { boxId: string } | { boxJobId: string },
): Promise<RegisteredManager | undefined> {
  const hint = detectHostSession();
  return hint ? registerHostManager(client, hint, attach) : undefined;
}

let sessionHeaderMemo: { value: string | undefined } | undefined;

/**
 * `X-AgentBox-Session` for this process: `<agent>:<sessionId>`, or undefined
 * outside a host agent session. Memoized, and detected without the pid walk: the
 * hub only needs the session's name to stamp who made a change.
 */
export function currentSessionHeader(): string | undefined {
  if (!sessionHeaderMemo) {
    const hint = detectHostSession({ pidless: true });
    sessionHeaderMemo = { value: hint ? `${hint.agent}:${hint.sessionId}` : undefined };
  }
  return sessionHeaderMemo.value;
}
