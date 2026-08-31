import {
  type AgentActivityState,
  type AgentPlanPayload,
  type AgentQuestionPayload,
  type AgentStatusEntry,
  type AgentStatusMap,
  type AgentId,
} from '@agentbox/core';

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
  ports: BoxStatusPort[];
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
 * The per-agent activity contract now lives in `@agentbox/core` — the leaf both
 * this daemon and the host relay can reach (ctl depends on relay, never the
 * reverse). ctl re-exports it so its own importers (the CLI, sandbox-docker,
 * the hub) resolve it from one place.
 *
 * These were also re-exported under claude-shaped aliases — `ClaudeActivityState`,
 * `ClaudePlanPayload`, `ClaudeQuestionPayload`, `BoxStatusClaude/Codex/Opencode`,
 * `CLAUDE_ACTIVITY_STATES`. None was ever claude-specific (codex and opencode
 * shared every state), so they are deleted rather than deprecated.
 */
export type {
  AgentActivityState,
  AgentPlanPayload,
  AgentQuestionPayload,
  AgentStatusEntry,
  AgentStatusMap,
} from '@agentbox/core';
export { AGENT_ACTIVITY_STATES } from '@agentbox/core';

export interface BoxStatusServiceEntry {
  name: string;
  state: ServiceState;
  /** Configured `ready_when` port for this service, else null. */
  port: number | null;
  /**
   * Whether the service declares a `ready_when` probe (port OR log_match). A
   * probed service stays in `running` until its probe passes and only then
   * becomes `ready`, so `running` does NOT mean "up" for it — readers should
   * treat a probed `running` service as still warming up. Additive field:
   * absent (older snapshots) means treat as unprobed (i.e. `running` is up).
   */
  probed?: boolean;
  /**
   * The service's `expose:` mapping (container `as` → in-box `port`) when it is
   * the designated web service, else absent. Additive field — snapshots written
   * before this existed simply lack it (schema stays 1; treat absent as none).
   */
  expose?: { port: number; as: number };
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
  /**
   * Every reporting agent, keyed by id. THE source of agent status — the named
   * fields below are a derived mirror of it.
   *
   * Additive (schema stays 1): a snapshot from a box baked before this field
   * existed simply lacks it, and `normalizeAgentStatus` reconstructs the map
   * from the named fields instead. Readers should go through that helper rather
   * than touching either shape directly.
   */
  agents?: AgentStatusMap;
  /**
   * The frozen legacy names, written as a MIRROR of `agents` so a host or hub
   * older than this build keeps reading activity. Skew runs both ways — a baked
   * ctl outlives the host that reads it, and a laptop CLI can be newer than a
   * control box's hub — and these drive decisions (the queue's working gate,
   * autopause, keepalive), not just display.
   *
   * Derived, never hand-maintained. A fourth agent appears only in `agents`,
   * which is correct: an old reader has no field for it either way.
   */
  claude?: AgentStatusEntry;
  codex?: AgentStatusEntry;
  opencode?: AgentStatusEntry;
}

export const BOX_STATUS_SCHEMA = 1 as const;

/** Relay event type carrying a `BoxStatus` payload. */
export const BOX_STATUS_EVENT = 'box-status';

/**
 * Relay event type carrying a refreshed agent credential blob (the
 * credentials watcher's payload). The host relay mirrors this constant
 * (`packages/relay/src/server.ts`, like `box-status`) — it special-cases the
 * type so the secret payload never lands in the event ring buffer.
 */
export const CREDENTIALS_UPDATED_EVENT = 'credentials-updated';

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
  | { op: 'agent-session'; sessionName?: string }
  | {
      /**
       * One op for every agent. The three `<agent>-state` CLI commands all send
       * this — the socket is intra-box (a short-lived `agentbox-ctl` process
       * talking to the daemon from the SAME binary), so the wire never spans two
       * builds and needs no per-agent spellings. The CLI command names are the
       * surface that does span builds; see `bin.ts`.
       */
      op: 'agent-state';
      agent: AgentId;
      state: AgentActivityState;
      /**
       * Optional payload from a pre-tool hook. For `end-plan` carries the plan
       * body; for `question` carries the question params. Cleared when the
       * matching post-tool hook fires with `state: 'working'` and
       * `clearPending: true`.
       */
      plan?: AgentPlanPayload;
      question?: AgentQuestionPayload;
      /**
       * Set by the matching post-tool hook (`--clear-pending`) to force-exit a
       * sticky end-plan/question state. The catchall pre-tool `working` hook
       * races with the matcher-specific `end-plan`/`question` hook on the same
       * tool invocation; sticky semantics in the reporter swallow that race, and
       * `clearPending` marks the legitimate post-tool transition out.
       */
      clearPending?: boolean;
    };

export type CtlResponse = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * Status of an in-container tmux session running an agent. The daemon doesn't
 * own the session lifecycle — it probes via `tmux has-session` and
 * `tmux display-message`. Missing tmux server / missing session both surface
 * as `running: false`.
 */
export interface AgentSessionStatus {
  running: boolean;
  sessionName: string;
  /** ISO-8601 timestamp from tmux's `#{session_created}`, or null when not running. */
  startedAt: string | null;
  /**
   * Sanitized tmux `#{pane_title}` (the title the agent set on its terminal),
   * or null when not running / no meaningful title.
   */
  title: string | null;
}

export const DEFAULT_SOCKET_PATH = '/run/agentbox/ctl.sock';
export const DEFAULT_CONFIG_PATH = '/workspace/agentbox.yaml';
export const DEFAULT_LOG_DIR = '/var/log/agentbox';
// Where run_once task completion markers live. On the box rootfs (survives
// pause/stop/start and is captured by `docker commit` checkpoints) but NOT under
// /workspace, so markers never show up as untracked git changes.
export const DEFAULT_STATE_DIR = '/var/lib/agentbox';
export const DEFAULT_CLAUDE_SESSION_NAME = 'claude';
export const DEFAULT_CODEX_SESSION_NAME = 'codex';
export const DEFAULT_OPENCODE_SESSION_NAME = 'opencode';
