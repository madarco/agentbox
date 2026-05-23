/**
 * The per-box state record persisted to `~/.agentbox/state.json`. Shared by
 * every provider: a box may be a local Docker container or a remote cloud
 * sandbox. The `provider` discriminator says which; provider-specific fields
 * live flat (Docker, for historical reasons) or under `cloud` (cloud backends).
 */

/** Sandbox backend a box runs on. Open-ended so future providers need no core change. */
export type ProviderName = 'docker' | 'daytona' | (string & {});

/**
 * Cloud-backend-specific fields for a box. Populated only when
 * `BoxRecord.provider` is a cloud provider; `undefined` for Docker boxes.
 */
export interface CloudBoxFields {
  /** Cloud backend name, e.g. 'daytona'. Mirrors `BoxRecord.provider`. */
  backend: string;
  /** Provider-native sandbox id (the handle the backend SDK resolves). */
  sandboxId: string;
  /** Resolved base image / snapshot ref the sandbox was provisioned from. */
  image?: string;
  /**
   * In-box port the web service is exposed on (the supervisor's WebProxy
   * listen port). Cloud boxes bind a non-privileged port; Docker boxes use 80.
   */
  webPort?: number;
  /**
   * Token-authed preview URLs keyed by in-box port. Resolved at create and
   * refreshed on every start (preview tokens can rotate across stop/start).
   */
  previewUrls?: Record<number, string>;
  /**
   * Preview URL of the in-sandbox relay's `/bridge/*` surface — the channel the
   * host CloudBoxPoller drains. Refreshed on start alongside `previewUrls`.
   */
  relayPreviewUrl?: string;
  /**
   * Daytona-style preview-proxy token for `relayPreviewUrl` (sent as
   * `x-daytona-preview-token` header). Persisted so a relay restart can
   * rehydrate the poller without re-resolving from the SDK.
   */
  relayPreviewToken?: string;
  /**
   * Bearer secret authenticating the host poller to the in-sandbox relay's
   * `/bridge/*` routes. Distinct from `BoxRecord.relayToken` (the per-box token
   * the in-box agent sees) so a compromised agent cannot impersonate the host.
   */
  bridgeToken?: string;
  /**
   * User-facing checkpoint name this box was provisioned from (e.g. `setup`),
   * when `agentbox create --checkpoint <name>` resolved to a cloud snapshot.
   * Surfaces in `agentbox status --inspect` so the user can tell which
   * checkpoint a box is currently running.
   */
  snapshotRef?: string;
}

export interface GitWorktreeRecord {
  kind: 'root' | 'nested';
  /** Host path to the main repo whose `.git/` is the source of the worktree. */
  hostMainRepo: string;
  /**
   * Agent-visible container path of the worktree (`/workspace` for root,
   * `/workspace/<sub>` for nested).
   */
  containerPath: string;
  /**
   * Per-box unique path where git registered the worktree. Docker boxes
   * register against the bind-mounted host `.git/`; cloud boxes clone into the
   * sandbox so this is a sandbox-local path. `destroyBox` uses it to deregister
   * a Docker worktree on the host.
   */
  gitWorktreePath: string;
  /** Branch the worktree was created on, e.g. `agentbox/<box-name>`. */
  branch: string;
  /** Workspace-relative path the repo was found at (empty string for root). */
  relPathFromWorkspace: string;
}

export interface BoxRecord {
  id: string;
  name: string;
  /**
   * Sandbox backend the box runs on. Absent on records written before the
   * multi-provider split — `readState` migrates those to `'docker'` on read.
   */
  provider?: ProviderName;
  container: string;
  /**
   * The image the box was started from. For plain boxes this is
   * `agentbox/box:dev` (the base image); for boxes started from a checkpoint
   * it's the checkpoint image tag (and `checkpointImage` mirrors it).
   */
  image: string;
  workspacePath: string;
  /**
   * Optional per-box scratch dir holding a `cp -c` APFS clone of the host
   * workspace, made at create time when `--host-snapshot` is on. Docker only.
   */
  snapshotDir?: string | null;
  /**
   * Host-side path to the agentbox-ctl unix socket bind-mounted into the
   * container at /run/agentbox/ctl.sock. Docker only.
   */
  socketPath?: string;
  /** Docker volume mounted at /home/vscode/.claude inside the box. Docker only. */
  claudeConfigVolume?: string;
  /** Docker volume mounted at /home/vscode/.codex inside the box. Docker only. */
  codexConfigVolume?: string;
  /** Docker volume mounted at /home/vscode/.local/share/opencode. Docker only. */
  opencodeConfigVolume?: string;
  /** Per-box volume holding `.vscode-server`. Docker only. */
  vscodeServerVolume?: string;
  /** Per-box volume holding `.cursor-server`. Docker only. */
  cursorServerVolume?: string;
  /**
   * Bearer token the in-box supervisor uses to authenticate with the relay.
   * Generated at create time and forwarded as AGENTBOX_RELAY_TOKEN.
   */
  relayToken?: string;
  /** Per-box git worktrees. Empty/absent when the host workspace is not a git checkout. */
  gitWorktrees?: GitWorktreeRecord[];
  /** True when the box was created with --with-playwright. */
  withPlaywright?: boolean;
  /** True when the box was created with --with-env. */
  withEnv?: boolean;
  /** VNC stack (Xvnc + websockify + noVNC) is enabled for this box. */
  vncEnabled?: boolean;
  /** Container-side noVNC web port. */
  vncContainerPort?: number;
  /** Host port mapped to the noVNC web server (Docker), or preview port (cloud). */
  vncHostPort?: number;
  /** Per-box password baked into Xvnc's PasswordFile and the auto-connect URL. */
  vncPassword?: string;
  /** Container port reserved for the web service `expose:` forward. */
  webContainerPort?: number;
  /** Host port mapped to container :80 (Docker). */
  webHostPort?: number;
  /** Portless route name registered for this box's web port. Docker only. */
  portlessAlias?: string;
  /** Full user-facing URL the Portless proxy serves for this box. Docker only. */
  portlessUrl?: string;
  /** Volume mounted at /var/lib/docker for the in-box dockerd. Docker only. */
  dockerVolume?: string;
  /** True when this box's `dockerVolume` is the shared cache. Docker only. */
  dockerCacheShared?: boolean;
  /** Absolute host path of the project this box belongs to. */
  projectRoot?: string;
  /** Monotonic 1-based index within `projectRoot`. Never recycled. */
  projectIndex?: number;
  /** The checkpoint image tag this box was started from. Docker only. */
  checkpointImage?: string;
  /** Lineage of the checkpoint this box was started from. */
  checkpointSource?: {
    ref: string;
    type: 'layered' | 'flattened';
    /** Checkpoint refs composing the chain, base-most last. */
    chain: string[];
  };
  /** Resource ceilings actually applied at create. */
  resourceLimits?: {
    memoryBytes?: number;
    cpus?: number;
    pidsLimit?: number;
    disk?: string;
  };
  /** Cloud-backend-specific fields. Present only for cloud providers. */
  cloud?: CloudBoxFields;
  createdAt: string; // ISO-8601
}

export interface StateFile {
  version: 1;
  boxes: BoxRecord[];
}

export type FindBoxResult =
  | { kind: 'ok'; box: BoxRecord }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: BoxRecord[] };
