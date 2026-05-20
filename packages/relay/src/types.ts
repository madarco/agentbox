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
