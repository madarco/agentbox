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
 * Coarse activity state of the in-box Claude Code session, fed by Claude Code
 * hooks via `agentbox-ctl claude-state <state>`. `unknown` is the initial value
 * before any hook has fired (or for boxes whose image predates the hooks).
 *
 * `end-plan` and `question` are PreToolUse-driven fine-grained states: Claude
 * is about to call ExitPlanMode (plan finished, awaiting human approval) or
 * AskUserQuestion (interactive prompt shown). The matching PostToolUse hook
 * clears them back to `working`. The hook also pipes the tool input JSON to
 * the daemon so `agentbox agent get-plan-question` can read the plan body or
 * the questions[] array without scraping the terminal.
 *
 * `compacting` is fed by Claude's PreCompact hook (the conversation is being
 * summarized to free context space). PostCompact clears it via
 * `working --clear-pending`. `error` is fed by StopFailure (a turn ended with
 * an unrecoverable failure); the next UserPromptSubmit / Stop naturally
 * supersedes it.
 *
 * The same union is reused for Codex and OpenCode via {@link AgentActivityState}.
 */
export type ClaudeActivityState =
  | 'working'
  | 'idle'
  | 'waiting'
  | 'end-plan'
  | 'question'
  | 'compacting'
  | 'error'
  | 'unknown';

export const CLAUDE_ACTIVITY_STATES: readonly ClaudeActivityState[] = [
  'working',
  'idle',
  'waiting',
  'end-plan',
  'question',
  'compacting',
  'error',
  'unknown',
];

/** Body shape extracted from the ExitPlanMode hook payload. */
export interface ClaudePlanPayload {
  /** Markdown plan body — Claude Code's `plan` tool input field. */
  plan: string;
  /** ISO-8601 timestamp the hook fired. */
  capturedAt: string;
}

/** Body shape extracted from the AskUserQuestion hook payload. */
export interface ClaudeQuestionPayload {
  /** Each entry is one question Claude is asking; usually length 1. */
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
  capturedAt: string;
}

/**
 * Same coarse activity union, reused for any agent. Codex feeds it via
 * `agentbox-ctl codex-state <state>` (Codex lifecycle hooks); the value space
 * is identical to {@link ClaudeActivityState}.
 */
export type AgentActivityState = ClaudeActivityState;

export interface BoxStatusServiceEntry {
  name: string;
  state: ServiceState;
  /** Configured `ready_when` port for this service, else null. */
  port: number | null;
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

export interface BoxStatusClaude {
  state: ClaudeActivityState;
  /** ISO-8601 time the last claude-state hook fired, or null if none yet. */
  updatedAt: string | null;
  /** Whether the claude tmux session was present at snapshot time. */
  sessionRunning: boolean;
  /**
   * Human-readable title Claude Code set on its terminal (the in-box tmux
   * pane title), sanitized. Additive field — snapshots written before this
   * existed simply lack it (schema stays 1; treat absent as no title).
   */
  sessionTitle?: string;
  /**
   * Last captured plan body — populated when `state === 'end-plan'`. The
   * matching PostToolUse hook clears it. Additive — older snapshots lack it.
   */
  plan?: ClaudePlanPayload;
  /**
   * Last captured AskUserQuestion content — populated when `state === 'question'`.
   * Cleared on the matching PostToolUse hook. Additive.
   */
  question?: ClaudeQuestionPayload;
}

/**
 * Codex session status — parallel to {@link BoxStatusClaude}. `state` is fed by
 * Codex lifecycle hooks via `agentbox-ctl codex-state <state>`.
 */
export interface BoxStatusCodex {
  state: AgentActivityState;
  /** ISO-8601 time the last codex-state hook fired, or null if none yet. */
  updatedAt: string | null;
  /** Whether the codex tmux session was present at snapshot time. */
  sessionRunning: boolean;
  /** Sanitized in-box tmux pane title, when the Codex TUI set one. */
  sessionTitle?: string;
}

/**
 * OpenCode session status — parallel to {@link BoxStatusClaude} /
 * {@link BoxStatusCodex}. `state` is fed by the agentbox OpenCode plugin
 * (seeded into `~/.config/opencode/plugin/agentbox-state.js`) which
 * subscribes to OpenCode's event bus and shells `agentbox-ctl opencode-state`
 * for each lifecycle transition.
 */
export interface BoxStatusOpencode {
  state: AgentActivityState;
  /** ISO-8601 time the last opencode-state hook fired, or null if none yet. */
  updatedAt: string | null;
  /** Whether the opencode tmux session was present at snapshot time. */
  sessionRunning: boolean;
  /** Sanitized in-box tmux pane title, when the OpenCode TUI set one. */
  sessionTitle?: string;
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
  /**
   * Codex / OpenCode session status. Additive + optional — present only when
   * that agent's tmux session is running (or, for codex, a hook has fired);
   * a claude-only box's snapshot simply omits them (schema stays 1).
   */
  codex?: BoxStatusCodex;
  opencode?: BoxStatusOpencode;
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
  | {
      op: 'claude-state';
      state: ClaudeActivityState;
      /**
       * Optional payload from a PreToolUse hook. For `end-plan` carries the
       * plan body; for `question` carries the AskUserQuestion params. Cleared
       * when the matching PostToolUse hook fires with `state: 'working'` and
       * `clearPending: true`.
       */
      plan?: ClaudePlanPayload;
      question?: ClaudeQuestionPayload;
      /**
       * Set by the matching PostToolUse hook (`claude-state working
       * --clear-pending`) to force-exit a sticky end-plan/question state. The
       * catchall PreToolUse `working` hook races with the matcher-specific
       * `end-plan`/`question` hook on the same tool invocation; sticky
       * semantics in the reporter swallow that race, and `clearPending`
       * marks the legitimate post-tool transition out.
       */
      clearPending?: boolean;
    }
  | { op: 'codex-state'; state: AgentActivityState }
  | { op: 'opencode-state'; state: AgentActivityState };

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
  /**
   * Sanitized tmux `#{pane_title}` (the title Claude Code set on its
   * terminal), or null when not running / no meaningful title.
   */
  title: string | null;
}

export const DEFAULT_SOCKET_PATH = '/run/agentbox/ctl.sock';
export const DEFAULT_CONFIG_PATH = '/workspace/agentbox.yaml';
export const DEFAULT_LOG_DIR = '/var/log/agentbox';
export const DEFAULT_CLAUDE_SESSION_NAME = 'claude';
export const DEFAULT_CODEX_SESSION_NAME = 'codex';
export const DEFAULT_OPENCODE_SESSION_NAME = 'opencode';
