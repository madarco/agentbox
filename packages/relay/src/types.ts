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
  /** Host path to the worktree directory. */
  hostWorktreeDir: string;
  /** Branch the worktree was created on. */
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
