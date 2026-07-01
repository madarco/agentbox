export const DEFAULT_RELAY_PORT = 8787;
/**
 * In-box relay port — distinct from {@link DEFAULT_RELAY_PORT} so a nested
 * agentbox run (developing agentbox inside a box) can bind its own host
 * relay on 8787 inside the outer box without colliding with the in-box
 * supervisor's relay. ctl always binds this port — as a real `mode: 'box'`
 * relay in cloud sandboxes, or a transparent forwarder to the host relay in
 * docker boxes. Override with `AGENTBOX_BOX_RELAY_PORT`.
 */
export const DEFAULT_BOX_RELAY_PORT = 8788;
export const RELAY_CONTAINER_NAME = 'agentbox-relay';
export const RELAY_NETWORK_NAME = 'agentbox-net';
export const RELAY_IMAGE_REF = 'agentbox/relay:dev';
export const RELAY_EVENT_RING_SIZE = 1000;

export type BoxKind = 'docker' | 'cloud';

export interface BoxRegistration {
  boxId: string;
  token: string;
  name: string;
  /** ISO-8601 time the relay received this registration. */
  registeredAt: string;
  /**
   * Which sandbox backend the box runs on. Drives whether the host relay
   * spawns a `CloudBoxPoller` for it. Absent on legacy registrations →
   * treated as 'docker'.
   */
  kind?: BoxKind;
  /**
   * For `kind === 'cloud'`: which cloud backend the executor must resolve
   * (e.g. 'daytona'). The host action executor lazy-imports
   * `@agentbox/sandbox-{backend}` to drive the in-sandbox channel.
   */
  backend?: string;
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
  /**
   * Preview URL of the in-sandbox relay's `/bridge/*` surface. Set by cloud
   * registrations; the host's `CloudBoxPoller` long-polls it for status +
   * queued host-only RPCs.
   */
  previewUrl?: string;
  /**
   * Provider-proxy token for `previewUrl` (e.g. Daytona's
   * `x-daytona-preview-token`). The host poller attaches it as a header so
   * Daytona's preview proxy lets the request reach the in-sandbox relay.
   */
  previewToken?: string;
  /**
   * Bearer secret authenticating the host poller to `/bridge/*` on the
   * in-sandbox relay. Distinct from `token` (which the in-box agent sees)
   * so a compromised agent can't impersonate the host.
   */
  bridgeToken?: string;
  /**
   * When true, host-action confirm prompts for this box (git push, cp,
   * gh writes, checkpoint, browser.open) resolve to `y` without a human/orchestrator
   * answering. Set at registration from `box.autoApproveHostActions`. Off by
   * default; every auto-approval still emits a `host-action-auto-approved`
   * relay event so the bypass is auditable.
   */
  autoApproveHostActions?: boolean;
  /**
   * The box repo's origin remote URL (any git URL shape). The hosted control
   * plane resolves owner/repo from THIS registered value when leasing a
   * GitHub-App token (never from box-supplied RPC params). Absent for boxes
   * without a git origin.
   */
  originUrl?: string;
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
  /** Sandbox backend kind. Defaults to 'docker' when absent (legacy). */
  kind?: BoxKind;
  /** For cloud boxes: which backend (e.g. 'daytona'). Drives executor lazy-import. */
  backend?: string;
  containerName?: string;
  createdAt?: string;
  /**
   * 1-based per-project box index. Optional — additive; older boxes and
   * legacy (pre-feature) records register without it and the status path
   * falls back to `<id>-<mnemonic>`.
   */
  projectIndex?: number;
  worktrees?: BoxWorktree[];
  /** Required when `kind === 'cloud'`: in-sandbox relay's /bridge URL. */
  previewUrl?: string;
  /** When the cloud provider's proxy needs a token (Daytona) — attached as a header. */
  previewToken?: string;
  /** Required when `kind === 'cloud'`: bearer for /bridge/* auth. */
  bridgeToken?: string;
  /**
   * Mirrors `box.autoApproveHostActions`: when true, host-action confirm
   * prompts auto-resolve to `y` (audited via a relay event).
   */
  autoApproveHostActions?: boolean;
  /** The box repo's origin remote URL (for GitHub-App lease repo resolution). */
  originUrl?: string;
}

/**
 * A host-only RPC the in-sandbox relay (box mode) parked while waiting for
 * the host poller to drain, execute on the host, and post back a result.
 * Equivalent of an in-flight `/rpc` call queued through the bridge.
 */
export interface HostAction {
  /** Server-generated uuid; the host poller echoes it back in the result. */
  id: string;
  /** Box that initiated the in-sandbox `/rpc`. */
  boxId: string;
  /** Original `/rpc` method (e.g. 'git.push', 'cp.toHost'). */
  method: string;
  /** Original `/rpc` params payload, opaque to the queue. */
  params: unknown;
  /** ISO-8601 enqueue time. */
  createdAt: string;
}

export interface HostActionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Response shape for `GET /bridge/poll`. */
export interface BridgePollResponse {
  /** Newly-queued host actions the poller hasn't drained yet. */
  actions: HostAction[];
  /** Events appended since `?since=<id>`. */
  events: RelayEvent[];
  /** Latest box-status snapshot, when one has been pushed. */
  status: unknown | null;
  /** Highest event id seen — the poller's next `?since=`. */
  cursor: number;
}

/** Body of `POST /bridge/action-result`. */
export interface BridgeActionResultBody {
  id: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitRpcParams {
  /** Container path identifying which worktree to run against. Defaults to /workspace. */
  path?: string;
  /** Remote name; defaults to 'origin'. */
  remote?: string;
  /** Extra argv tail appended after the standard args (e.g. ['--set-upstream', 'origin', 'branch']). */
  args?: string[];
  /**
   * git.push only: land the box's branch in the host's *local* repo instead of
   * pushing to the remote. Nothing is published online; the relay skips the
   * host-initiated-token / confirm-prompt gate (that gate guards remote pushes).
   */
  hostOnly?: boolean;
  /**
   * git.push --host-only only: destination branch name in the host repo.
   * Defaults to the box's current branch name when omitted.
   */
  as?: string;
  /** git.push --host-only only: allow a non-fast-forward overwrite of the destination branch. */
  force?: boolean;
  /**
   * One-time token minted by the host CLI via `/admin/host-initiated/mint`
   * before invoking this RPC through `agentbox-ctl`. The relay validates the
   * token against its in-memory store, scoped to `(boxId, method)`; on
   * match, the token is consumed and the confirm prompt is skipped. Boxes
   * cannot mint these (the admin endpoint is loopback-only), so a malicious
   * agent cannot forge "host-initiated" calls. Invalid/expired tokens fall
   * through to the normal prompt path.
   */
  hostInitiated?: string;
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

/**
 * Notice kinds. `checkpoint` is the first — a box is transiently frozen
 * while a checkpoint is captured (`docker commit` pauses the container).
 * Kept open-ended like {@link PromptKind} so an older wrapper degrades
 * gracefully (renders the message) when a newer relay sends a new kind.
 */
export type NoticeKind = 'checkpoint';

/**
 * The shape pushed over SSE on `event: notice-set`. Unlike a prompt, a
 * notice is purely informational — there is no answer and the box's RPC
 * is not blocked on it. The host wrapper renders it as an animated footer
 * line so the user knows the box is busy, not stuck. Cleared by a
 * `notice-clear` event carrying `{ id }`.
 */
export interface BoxNoticeEvent {
  /** Relay-generated UUIDv4. */
  id: string;
  kind: NoticeKind;
  /** Warning text; the wrapper truncates to footer width. */
  message: string;
}

/** Body of `POST /admin/notices/set`; the response is `{ id }`. */
export interface SetNoticeBody {
  boxId: string;
  kind: NoticeKind;
  message: string;
  /** Auto-expiry backstop in ms; defaults relay-side. */
  ttlMs?: number;
}

/** Body of `POST /admin/notices/clear`. */
export interface ClearNoticeBody {
  boxId: string;
  id: string;
}

export interface CpRpcParams {
  /**
   * Source path(s): box paths for `cp.toHost`, host paths for `cp.fromHost`.
   * The host CLI side is what carries the `<box>:` prefix when re-shelled.
   */
  sources?: string[];
  /** Destination path: host path for `cp.toHost`, box path for `cp.fromHost`. */
  dest?: string;
  /**
   * Legacy single-source wire shape (older in-box `agentbox-ctl` baked into a
   * box image before multi-source support). The relay normalizes these into
   * `sources`/`dest`. `boxPath` is the container path; `hostPath` the host path
   * (dst for toHost, src for fromHost).
   */
  boxPath?: string;
  hostPath?: string;
  /** Defaults true; relay always uses `docker exec tar` (recursive). */
  recursive?: boolean;
  /** tar glob patterns / bare dir names to exclude, forwarded to `agentbox cp --exclude`. */
  exclude?: string[];
  /** false → forward `--no-default-excludes` (keep heavy dirs the host CLI drops). */
  defaultExcludes?: boolean;
  /** true → forward `--yes` (copy past the host's size limit). */
  yes?: boolean;
}

export interface BrowserOpenRpcParams {
  /** Absolute http(s) URL to open in the host's default browser. */
  url: string;
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
