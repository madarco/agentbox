export type ServiceState =
  | 'pending'
  | 'waiting'
  | 'starting'
  | 'running'
  | 'ready'
  | 'unhealthy'
  | 'crashed'
  | 'backoff'
  | 'stopped';

export type TaskState = 'pending' | 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

export interface ServiceStatus {
  name: string;
  state: ServiceState;
  pid: number | null;
  restarts: number;
  lastExitCode: number | null;
  startedAt: string | null;
  readyAt: string | null;
  nextRetryAt: string | null;
  blockedOn: string[];
  command: string;
}

export interface StatusReply {
  services: ServiceStatus[];
  tasks: TaskStatus[];
}

export interface WaitReadyArgs {
  timeoutMs?: number;
  units?: string[];
}

export type WaitReadyReply =
  | { ready: true }
  | { ready: false; timedOut: string[]; failed: string[] };

export interface TaskStatus {
  name: string;
  state: TaskState;
  pid: number | null;
  lastExitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  command: string;
}

export interface LogEvent {
  service: string;
  ts: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface ReloadResult {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Coarse activity state of the in-box Claude Code session, fed by Claude Code
 * hooks via `agentbox-ctl claude-state <state>`. `unknown` is the initial value
 * before any hook has fired (or for boxes whose image predates the hooks).
 */
export type ClaudeActivityState = 'working' | 'idle' | 'waiting' | 'unknown';

export const CLAUDE_ACTIVITY_STATES: readonly ClaudeActivityState[] = [
  'working',
  'idle',
  'waiting',
  'unknown',
];

export interface BoxStatusServiceEntry {
  name: string;
  state: ServiceState;
  /** Configured `ready_when` port for this service, else null. */
  port: number | null;
}

export interface BoxStatusTaskEntry {
  name: string;
  state: TaskState;
}

export interface BoxStatusPort {
  port: number;
  /** Name of the service whose `ready_when` port matches, else null (ad-hoc). */
  service: string | null;
}

export interface BoxStatusClaude {
  state: ClaudeActivityState;
  /** ISO-8601 time the last claude-state hook fired, or null if none yet. */
  updatedAt: string | null;
  /** Whether the claude tmux session was present at snapshot time. */
  sessionRunning: boolean;
}

/**
 * Durable snapshot of a box's runtime status. The in-box daemon builds it and
 * pushes it to the host relay, which persists it to
 * `~/.agentbox/boxes/<id>/status.json` so `agentbox status` / `list` /
 * `inspect` can show it even when the box is paused or stopped.
 */
export interface BoxStatus {
  /** Schema version; bump on incompatible changes so old readers can reject. */
  schema: 1;
  boxId: string;
  /** ISO-8601 time the daemon built this snapshot. */
  timestamp: string;
  services: BoxStatusServiceEntry[];
  tasks: BoxStatusTaskEntry[];
  /** Live-discovered listening TCP ports inside the box. */
  ports: BoxStatusPort[];
  claude: BoxStatusClaude;
}

export const BOX_STATUS_SCHEMA = 1 as const;

/** Relay event type carrying a `BoxStatus` payload. */
export const BOX_STATUS_EVENT = 'box-status';

export type CtlRequest =
  | { op: 'status' }
  | { op: 'task-status' }
  | { op: 'wait-ready'; timeoutMs?: number; units?: string[] }
  | { op: 'run-task'; name: string; force?: boolean }
  | { op: 'logs'; service: string; tail?: number; follow?: boolean }
  | { op: 'restart'; service: string }
  | { op: 'stop'; service: string }
  | { op: 'start'; service: string }
  | { op: 'reload' }
  | { op: 'ping' }
  | { op: 'claude-session'; sessionName?: string }
  | { op: 'claude-state'; state: ClaudeActivityState };

export type CtlResponse = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * Status of the in-container tmux session running Claude Code. The daemon
 * doesn't own this session lifecycle — it probes via `tmux has-session` and
 * `tmux display-message`. Missing tmux server / missing session both surface
 * as `running: false`.
 */
export interface ClaudeSessionStatus {
  running: boolean;
  sessionName: string;
  /** ISO-8601 timestamp from tmux's `#{session_created}`, or null when not running. */
  startedAt: string | null;
}

export const DEFAULT_SOCKET_PATH = '/run/agentbox/ctl.sock';
export const DEFAULT_CONFIG_PATH = '/workspace/agentbox.yaml';
export const DEFAULT_LOG_DIR = '/var/log/agentbox';
export const DEFAULT_CLAUDE_SESSION_NAME = 'claude';
