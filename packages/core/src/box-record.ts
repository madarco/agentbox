/**
 * The per-box state record persisted to `~/.agentbox/state.json`. Shared by
 * every provider: a box may be a local Docker container or a remote cloud
 * sandbox. The `provider` discriminator says which; provider-specific fields
 * live flat (Docker, for historical reasons) or under `cloud` (cloud backends).
 */

import type { InboundPolicy } from './cloud-backend.js';
import type { BoxRuntimeState } from './provider.js';
import type { SyncTopology } from './sync/types.js';

/** Sandbox backend a box runs on. Open-ended so future providers need no core change. */
export type ProviderName = 'docker' | 'daytona' | 'hetzner' | (string & {});

/**
 * Docker-backend-specific fields nested under `BoxRecord.docker` once 7.1
 * lands fully. Today every Docker box also keeps the flat copies of these
 * fields on `BoxRecord` directly for back-compat (state.json migration is
 * the rest of 7.1) — write sites populate both shapes; read sites still
 * use the flat fields. New code should target this interface so the
 * eventual flat-field removal is a search-and-replace, not a redesign.
 */
export interface DockerBoxFields {
  /** Docker container name (`agentbox-<id|name>`). */
  container: string;
  /** Base image / checkpoint image tag the container was started from. */
  image: string;
  /** Per-box scratch dir with the `cp -c` APFS clone (when --host-snapshot is on). */
  snapshotDir?: string | null;
  /** Host-side path to the agentbox-ctl unix socket bind-mounted into the container. */
  socketPath?: string;
  /** Docker volume mounted at /home/vscode/.claude inside the box. */
  claudeConfigVolume?: string;
  /** Docker volume mounted at /home/vscode/.codex inside the box. */
  codexConfigVolume?: string;
  /** Docker volume mounted at /home/vscode/.agents inside the box (Agent Skills). */
  agentsConfigVolume?: string;
  /** Docker volume mounted at /home/vscode/.local/share/opencode. */
  opencodeConfigVolume?: string;
  /** Per-box volume holding `.vscode-server`. */
  vscodeServerVolume?: string;
  /** Per-box volume holding `.cursor-server`. */
  cursorServerVolume?: string;
  /** Host port mapped to the noVNC web server. */
  vncHostPort?: number;
  /** Host port mapped to container :80. */
  webHostPort?: number;
  /** Portless route name registered for this box's web port. */
  portlessAlias?: string;
  /** Full user-facing URL the Portless proxy serves for this box. */
  portlessUrl?: string;
  /** Portless route name registered for this box's noVNC port (`vnc-<box-name>`). */
  portlessVncAlias?: string;
  /** Full user-facing URL the Portless proxy serves for this box's VNC. */
  portlessVncUrl?: string;
  /** Volume mounted at /var/lib/docker for the in-box dockerd. */
  dockerVolume?: string;
  /** True when this box's `dockerVolume` is the shared cache. */
  dockerCacheShared?: boolean;
  /** Checkpoint image tag this box was started from. */
  checkpointImage?: string;
}

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
  /**
   * Last lifecycle state agentbox itself drove this box to (running on
   * create/start/resume, paused on pause/stop/vercel-checkpoint). `listBoxes`
   * shows this for cloud boxes so `agentbox list` stays instant — no SDK probe.
   * It reflects the last *host-initiated* op, not the authoritative live state
   * (a platform-side stop won't update it); `agentbox list --live` probes for
   * the real state. Absent on pre-feature records → treated as `running`.
   */
  lastState?: BoxRuntimeState;
  /**
   * Effective per-session timeout (ms) the sandbox was created with, when the
   * backend models one (vercel `Sandbox.create({ timeout })`). Recorded so the
   * host keepalive loop can seed its tracked death-time accurately (the
   * effective value can be project/workspace-overridden, not the global
   * default). Absent on backends without a session timeout / pre-feature records.
   */
  sessionTimeoutMs?: number;
  /**
   * Actual resources the backend provisioned, read back from the create
   * response (Hetzner reports the real `server_type` cores/memory/disk). Shown
   * by `agentbox status --inspect`. Absent on backends that can't report it and
   * on pre-feature records → readers fall back to the provider's static defaults.
   */
  resources?: { cpu?: number; memory?: number; disk?: number };
  /**
   * Inbound-access policy for VPS boxes (hetzner / digitalocean per-box
   * firewall). Persisted so a host-egress-IP drift re-sync (`repairReachability`
   * / `agentbox inbound`) recomputes `sources ∪ current-host-egress` without
   * losing the whitelist, and so `agentbox inbound --show` / `connect` can
   * report the box's current exposure. Absent on non-VPS backends / pre-feature
   * records → treated as `locked`.
   */
  inbound?: InboundPolicy;
  /**
   * Daytona sandbox class this box actually booted as (`linux-vm` | `container`).
   * Recorded from the class of the *snapshot* it booted from, not from config —
   * a user who flips `box.daytonaClass` while `box.imageDaytona` still points at
   * a snapshot of the other class must not have us lie about the running box.
   *
   * Threaded back into `CloudHandle.sandboxClass` so lifecycle ops can branch:
   * a VM pauses and cannot be archived, a container archives and cannot be
   * paused. Absent on non-Daytona backends and pre-feature records.
   */
  sandboxClass?: string;
  /**
   * True when this box's `/workspace` was seeded from the host checkout (the
   * laptop `create` path), i.e. it has a real fork base shared with the host.
   * Left unset for `inBoxClone` / plane boxes (they clone in-box from a leased
   * URL with no host fork base). Gates the session-start live-box resync — only
   * host-seeded boxes can merge the host's current state back in (Phase 7.5).
   */
  hostSeeded?: boolean;
  /**
   * The box's per-box branch (`agentbox/<name>`, or `--use-branch <b>`). The
   * merge target branch for the live-box resync; re-derived layout aside, this
   * is the one piece resync can't recover from the box alone.
   */
  workspaceBranch?: string;
  /**
   * Last branch the HOST sanctioned for this cloud box (defaults to
   * `workspaceBranch`, updated by host `agentbox git checkout`/`branch`/`pull
   * <branch>`). The cloud push gate auto-approves a push only to a scratch
   * branch OR this value — the cloud analogue of the docker registry's
   * `BoxWorktree.sanctionedBranch`. Absent → treated as `workspaceBranch`.
   */
  sanctionedBranch?: string;
  /**
   * The box's resolved sync federation shape (`resolveSyncTopology`). `'cloud'`
   * for a classic host-synced box, `'control-plane'` when its live relay is a
   * hosted control plane (the box forwards `/rpc` to the plane and leases push
   * tokens directly). Persisted so the value is stable across resumes.
   */
  topology?: SyncTopology;
  /**
   * The hosted control-plane base URL this box points at, when
   * `topology === 'control-plane'`. Persisted (not re-derived from config) so a
   * resume re-kick on a host whose config has changed/lacks the URL still
   * re-threads the box's forwarder upstream + `AGENTBOX_GIT_LEASE` correctly.
   */
  controlPlaneUrl?: string;
  /**
   * Git push routing (`git.pushMode`): `'auto' | 'relay' | 'lease' | 'direct'`.
   * Persisted (not re-derived from config) so a resume re-kick re-threads
   * `AGENTBOX_GIT_LEASE` / `AGENTBOX_GIT_DIRECT` correctly even if the host
   * config changed. Mirrors config's `GitPushMode`.
   */
  gitPushMode?: 'auto' | 'relay' | 'lease' | 'direct';
}

/**
 * Last resolved SSH connection target for a box — host/user, the per-box
 * identity file (identity-authed providers: docker localhost sshd, Hetzner),
 * and an optional port (docker publishes its sshd on an ephemeral loopback
 * port; cloud providers use the default 22). Persisted on `BoxRecord.ssh`
 * whenever we're already online (create/start/code/open/shell) so
 * `~/.agentbox/ssh/config` can be regenerated purely from state — the
 * regenerate never hits a provider API or wakes a paused box. The host IP /
 * loopback port can change across stop/start, so it is refreshed on start/resume.
 * Absent for providers with no SSH.
 */
export interface SshTargetRecord {
  host: string;
  user: string;
  identityFile?: string;
  port?: number;
  /**
   * SSH jump host (`ProxyJump`), for a box that is not directly reachable but
   * sits behind a machine that is. remote-docker's box is a container on someone
   * else's engine: its sshd is published on THAT machine's loopback, so ssh
   * hops through the engine and dials `127.0.0.1:<port>` from there. Spelled as
   * an ssh destination (`[user@]host[:port]` or an `~/.ssh/config` alias).
   * Absent for providers whose box is directly reachable.
   */
  proxyJump?: string;
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
  /**
   * The last branch the HOST put this box on — its create-time `branch`,
   * updated by host-driven `agentbox git checkout`/`branch`/`pull <branch>`.
   * Distinct from `branch` (which stays the immutable scratch identity used by
   * host-only land, checkout guards, and upstream-sync skip): the relay
   * auto-approves a push only to a scratch branch OR this sanctioned branch,
   * so an in-box agent self-switching to `main` and pushing still prompts.
   * Absent on records written before this field existed → treated as `branch`.
   */
  sanctionedBranch?: string;
  /** Workspace-relative path the repo was found at (empty string for root). */
  relPathFromWorkspace: string;
}

export interface BoxRecord {
  id: string;
  name: string;
  /**
   * Cosmetic user-chosen label, set via `agentbox status <box> --set-name`.
   * Purely for display and lookup — unlike `name` it does NOT drive the
   * container, git branch, or Portless URL. Absent means "fall back to name".
   * See docs/state.md.
   */
  displayName?: string;
  /**
   * Sandbox backend the box runs on. Absent on records written before the
   * multi-provider split — `readState` migrates those to `'docker'` on read.
   */
  provider?: ProviderName;
  /**
   * Unique runtime identifier. For docker records: the container name
   * (`agentbox-<id|name>`) — what `docker exec` resolves. For cloud
   * records: the backend sandbox id, prefixed with `cloud:` so a grep
   * for "agentbox-cloud-*" finds nothing (post 7.2) — the cloud
   * sandbox is not a docker container and shouldn't look like one.
   * Docker-internal code should only ever reach this via
   * `requireDockerProvider(box, ...)` first.
   */
  container: string;
  /**
   * The image the box was started from. Docker: base image or checkpoint
   * image tag. Cloud: the resolved sandbox image / snapshot ref (mirrors
   * `box.cloud.image`).
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
  /** Docker volume mounted at /home/vscode/.agents inside the box (Agent Skills). Docker only. */
  agentsConfigVolume?: string;
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
  /**
   * Resolved `box.autoApproveHostActions` at create time. Forwarded to the
   * host relay so host-action confirms (git push, cp, gh writes, checkpoint)
   * auto-resolve to `y` for this box — with an audit event per bypass.
   * Persisted so a `relay` rehydrate re-registers with the same policy.
   */
  autoApproveHostActions?: boolean;
  /**
   * Resolved `box.autoApproveSafeHostActions` at create time (default true).
   * Forwarded to the relay so the SAFE subset of host actions (open PR, PR
   * comments, sanctioned-branch push, contained non-secret file copy, CI
   * rerun, checkpoint, integration writes) auto-resolves without a prompt.
   * Absent is treated as enabled (default on) by the relay. Persisted so a
   * `relay` rehydrate re-registers with the same policy.
   */
  autoApproveSafeHostActions?: boolean;
  /**
   * Carry summary recorded at create time: which host paths were copied into
   * the box from `agentbox.yaml`'s `carry:` block. Audit trail for inspect
   * (the actual file content is not retained — only the src/dest pairs and
   * sizes). Absent when no carry: block was applied.
   */
  carry?: {
    count: number;
    /**
     * `hash` is a content hash of the host source at copy time, used by the
     * on-start resync to re-copy only entries whose host source changed.
     * Absent on records written before resync existed (treated as "changed").
     */
    entries: Array<{ src: string; dest: string; bytes: number; hash?: string }>;
  };
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
  /** In-box localhost sshd is enabled for this box (Docker). */
  sshEnabled?: boolean;
  /** Container-side sshd port (22). Docker. */
  sshContainerPort?: number;
  /** Ephemeral loopback host port mapped to the container's sshd (Docker). */
  sshHostPort?: number;
  /**
   * Last resolved SSH connection target. Regenerated into `~/.agentbox/ssh/config`
   * by `syncAgentboxSshConfig`. Docker: `127.0.0.1` + the per-box key + the
   * ephemeral `sshHostPort`; cloud (Hetzner): the VPS IP + per-box key.
   */
  ssh?: SshTargetRecord;
  /** Portless route name registered for this box's web port. Docker only. */
  portlessAlias?: string;
  /** Full user-facing URL the Portless proxy serves for this box. Docker only. */
  portlessUrl?: string;
  /** Portless route name registered for this box's noVNC port (`vnc-<box-name>`). */
  portlessVncAlias?: string;
  /** Full user-facing URL the Portless proxy serves for this box's VNC. */
  portlessVncUrl?: string;
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
  /**
   * Docker-backend-specific fields. Populated alongside the flat fields
   * during the 7.1 transition; once readers migrate, the flat fields go
   * away. New code SHOULD prefer `box.docker?.<field>` and fall back to
   * the flat field via the `dockerField()` helper in `@agentbox/core`.
   */
  docker?: DockerBoxFields;
  /** Cloud-backend-specific fields. Present only for cloud providers. */
  cloud?: CloudBoxFields;
  /**
   * The agent last launched in this box (`agentbox claude` / `codex` /
   * `opencode`). Recorded on every launch (foreground + queued). Durable, unlike
   * the in-box session pointers which are cleared on the running->stopped tmux
   * edge — so it's the signal `agentbox recover` uses to know which agent to
   * relaunch/attach, and the only such signal for an adopted box with no live
   * session.
   */
  lastAgent?: 'claude' | 'codex' | 'opencode';
  createdAt: string; // ISO-8601
}

/**
 * Read a Docker-specific field with fallback to the legacy flat slot.
 * Prefer this over `box.field` directly while the 7.1 migration is in
 * flight — once the flat fields are removed, this collapses to
 * `box.docker?.[key]` and the migration is mechanical.
 */
export function dockerField<K extends keyof DockerBoxFields>(
  box: BoxRecord,
  key: K,
): DockerBoxFields[K] | undefined {
  if (box.docker && box.docker[key] !== undefined) return box.docker[key];
  // Fall back to the flat copy. Container / image are required at the
  // BoxRecord top level so they always exist as flat fields today.
  return (box as unknown as Record<string, unknown>)[key as string] as
    | DockerBoxFields[K]
    | undefined;
}

export interface StateFile {
  version: 1;
  boxes: BoxRecord[];
}

export type FindBoxResult =
  | { kind: 'ok'; box: BoxRecord }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: BoxRecord[] };
