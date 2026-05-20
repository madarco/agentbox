export const DEFAULT_RELAY_PORT = 8787;
export const RELAY_CONTAINER_NAME = 'agentbox-relay';
export const RELAY_NETWORK_NAME = 'agentbox-net';
export const RELAY_IMAGE_REF = 'agentbox/relay:dev';
export const RELAY_EVENT_RING_SIZE = 1000;

export interface BoxRegistration {
  boxId: string;
  token: string;
  name: string;
  /** ISO-8601 time the relay received this registration. */
  registeredAt: string;
  /** Docker container name; the relay needs it to `docker pause` an idle box. */
  containerName?: string;
  /** ISO-8601 box-creation time (BoxRecord.createdAt); used as a tie-break in auto-pause ordering. */
  createdAt?: string;
  /**
   * 1-based per-project box index (`agentbox list`'s `N` column). When set,
   * the relay writes status.json under `~/.agentbox/boxes/<id>-<n>-<mnemonic>/`
   * to match the host's `boxDirSegment` helper. Absent for legacy
   * (pre-feature) boxes; absent registrations fall back to `<id>-<mnemonic>`.
   */
  projectIndex?: number;
  /**
   * Container-path → host-worktree-dir mapping the host uses to resolve
   * git.pull/git.push RPCs. Empty when the box has no git repos.
   */
  worktrees?: BoxWorktree[];
}

export interface BoxWorktree {
  /** Path inside the container (e.g. /workspace, /workspace/app). */
  containerPath: string;
  /**
   * Absolute host path of the main repo whose `.git/` is shared with the
   * container. `git push/fetch` RPCs run with `git -C <hostMainRepo>` — the
   * worktree's working tree lives inside the container's writable layer, but
   * refs/objects are in this shared `.git/`, so push from the main repo dir
   * sees the in-container commits.
   */
  hostMainRepo: string;
  /** Branch the in-container worktree was created on (`agentbox/<box-name>`). */
  branch: string;
}

export interface RelayEvent {
  /** Monotonic per-relay-process id, useful for `since=` polling. */
  id: number;
  /** Box id that posted the event. */
  boxId: string;
  /** Free-form event type, e.g. 'service-state', 'task-state', 'notify'. */
  type: string;
  /** ISO-8601 timestamp the relay assigned on receipt. */
  receivedAt: string;
  /** ISO-8601 client-supplied timestamp, if any. */
  ts?: string;
  /** Arbitrary JSON payload. */
  payload?: unknown;
}

export interface PostEventBody {
  type: string;
  ts?: string;
  payload?: unknown;
}

export interface PostRpcBody {
  method: string;
  params?: unknown;
}

export interface RegisterBoxBody {
  boxId: string;
  token: string;
  name: string;
  containerName?: string;
  createdAt?: string;
  /**
   * 1-based per-project box index. Optional — additive; older boxes and
   * legacy (pre-feature) records register without it and the status path
   * falls back to `<id>-<mnemonic>`.
   */
  projectIndex?: number;
  worktrees?: BoxWorktree[];
}

export interface GitRpcParams {
  /** Container path identifying which worktree to run against. Defaults to /workspace. */
  path?: string;
  /** Remote name; defaults to 'origin'. */
  remote?: string;
  /** Extra argv tail appended after the standard args (e.g. ['--set-upstream', 'origin', 'branch']). */
  args?: string[];
}

export interface GitRpcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CheckpointRpcParams {
  /** Checkpoint name; defaults host-side to `<box-name>-<next>`. */
  name?: string;
  /** Flatten lower+upper into one tree instead of a layered delta. */
  merged?: boolean;
  /** Mark the new checkpoint as the project default. */
  setDefault?: boolean;
  /**
   * If a checkpoint with the same name exists, rm it (manifest + image)
   * before capturing. Makes the call safe to retry — useful when the
   * agent's harness lost the previous invocation's stdout and can't tell
   * whether it succeeded.
   */
  replace?: boolean;
}

/**
 * First-cut prompt UX is a y/N confirmation in the host wrapper's footer.
 * `select` / `text` are reserved for a follow-up that grows the footer to
 * two rows; keeping the kind in the wire from day one means the host
 * wrapper can ignore unknown kinds gracefully when an older box hits a
 * newer relay (and vice-versa).
 */
export type PromptKind = 'confirm';

export interface PromptContext {
  /** Short label, e.g. "git push" or "cp toHost: /workspace/x -> ~/dl/x". */
  command?: string;
  /** Container path of the calling cwd, when known. */
  cwd?: string;
  /** Full argv; wrapper truncates for the footer. */
  argv?: string[];
}

/**
 * The shape pushed over SSE on `event: prompt-ask`. Also the shape the
 * relay-internal `askPrompt()` helper produces. Not a /rpc method — the
 * relay generates these itself when it is about to take a host-side
 * action; the in-box ctl never asks for prompts directly.
 */
export interface PromptAskEvent {
  /** Relay-generated UUIDv4 (the wrapper echoes it back in the answer). */
  id: string;
  kind: PromptKind;
  /** Primary question; wrapper truncates to footer width. */
  message: string;
  /** Optional second-line context; wrapper may show or skip. */
  detail?: string;
  /** Default when the user just hits Enter; default 'n' so y/N is the safe shape. */
  defaultAnswer?: 'y' | 'n';
  context?: PromptContext;
}

/** Body of `POST /admin/prompts/answer`. */
export interface PromptAnswerBody {
  id: string;
  answer: 'y' | 'n';
  /** Set when the user dismissed the prompt (Esc / Ctrl-c); treated as 'n'. */
  cancelled?: boolean;
}

export interface CpRpcParams {
  /** Container-side path. */
  boxPath: string;
  /** Host-side path (dst for toHost, src for fromHost). */
  hostPath: string;
  /** Defaults true; relay always uses `docker exec tar` (recursive). */
  recursive?: boolean;
}

export type DownloadKind = 'workspace' | 'env' | 'config' | 'claude';

export interface DownloadRpcParams {
  kind: DownloadKind;
  /**
   * Host destination override. Reserved — the v1 relay ignores it and uses
   * the host CLI's defaults (`box.workspacePath`, or `~/.claude`). Kept in
   * the wire so a later upgrade can land without bumping the type.
   */
  hostPath?: string;
  /** Reserved for per-kind flags (e.g. workspace: includeNodeModules). */
  options?: Record<string, unknown>;
}
