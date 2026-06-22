/**
 * `CloudBackend` — the thin SDK-level interface a cloud provider implements.
 * Just the primitives: provision a sandbox, exec, move files, lifecycle,
 * preview URLs. Everything else (relay wiring, workspace/git seeding, agent
 * config sync, the in-box supervisor, the host poller) is composed once by
 * `@agentbox/sandbox-cloud`'s `createCloudProvider(backend)` and reused by
 * every cloud backend. Adding a new cloud is then ~one file implementing this.
 */

/**
 * Persistent volume to mount into the sandbox at provision time. Backends
 * without a volume primitive ignore this field. `mountPath` is absolute inside
 * the sandbox; `subpath` (optional) mounts a subdirectory of the volume — the
 * shared-volume-per-tenant pattern.
 */
export interface CloudVolumeMount {
  volumeId: string;
  mountPath: string;
  subpath?: string;
}

export interface CloudProvisionRequest {
  name: string;
  /** Resolved base image / snapshot ref. */
  image: string;
  /**
   * Provider-native named snapshot to provision from. When set, takes
   * precedence over `image` — the new sandbox boots from the snapshot's
   * captured filesystem state (e.g. a post-setup `/workspace`, warmed-up
   * `node_modules`, etc.). Daytona maps this to `client.create({snapshot})`.
   * Backends without snapshot support ignore the field and fall back to `image`.
   */
  snapshot?: string;
  resources?: { cpu?: number; memory?: number; disk?: number };
  /**
   * Backend-interpreted size string. Hetzner reads it as a server type
   * (e.g. `cx33`); Daytona parses it as `cpu-memory-disk` GB (e.g. `4-8-20`)
   * and overrides `resources` when valid. Backends without a size knob ignore
   * the field.
   */
  size?: string;
  /**
   * Max session length in ms before the backend auto-snapshots/stops the
   * sandbox. Backends that don't model a session timeout ignore it; Vercel
   * maps it to `Sandbox.create({ timeout })`.
   */
  timeoutMs?: number;
  /**
   * Extra in-box service ports (from `agentbox.yaml` `expose`) the caller wants
   * reachable via `previewUrl`. Backends with a fixed port allowance (Vercel:
   * max 4, no privileged ports) merge these into the create-time port list up
   * to their cap; backends that route all ports through one proxy ignore it.
   */
  exposePorts?: number[];
  /**
   * Backend-interpreted egress policy string. Vercel maps it to a
   * `Sandbox.create({ networkPolicy })`: `allow-all` / `deny-all` / a
   * comma-separated domain allowlist. Backends without a native egress
   * primitive ignore it (hetzner locks egress via its own firewall instead).
   */
  networkPolicy?: string;
  /** Env vars baked into the sandbox at provision time. */
  env?: Record<string, string>;
  /** Persistent volumes to attach. Backends without a volume API ignore this. */
  volumes?: CloudVolumeMount[];
  onLog?: (line: string) => void;
}

/** Opaque handle to a provisioned sandbox. `sandboxId` is persisted on the box record. */
export interface CloudHandle {
  sandboxId: string;
}

export type CloudState = 'running' | 'paused' | 'stopped' | 'missing';

export interface CloudExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CloudExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  user?: string;
  /**
   * Per-attempt wall-clock cap. Defaults to the backend's exec default
   * (Daytona: 120s). Override for slow operations whose in-box runtime is
   * expected to exceed the default — e.g. extracting many small files into
   * a FUSE-backed volume where cp can take minutes.
   */
  attemptTimeoutMs?: number;
  /**
   * Disable retries for this call. Set when the command is not safely
   * idempotent against a still-running previous invocation — e.g. a
   * `rm -rf` + extract pipeline whose retry would race the earlier cp that
   * the SDK abandoned at the prior timeout, but which is still running
   * in-box.
   */
  noRetry?: boolean;
}

export interface CloudFileEntry {
  name: string;
  isDir: boolean;
}

/**
 * Token-authed preview URL returned by `CloudBackend.previewUrl(port)`. Some
 * providers (Daytona) gate previews with a `token` the caller must attach as
 * a header (e.g. `x-daytona-preview-token`) for any HTTP traffic that goes
 * through the proxy. Callers using the URL programmatically (the host
 * `CloudBoxPoller`, cp/upload) wire the token; the user-facing CLI `url`
 * command currently surfaces only the bare URL.
 */
export interface CloudPreviewUrl {
  url: string;
  /** Optional bearer/header token, when the backend's proxy requires one. */
  token?: string;
}

/**
 * Minimal description of an existing cloud sandbox returned by `list()`.
 * Backends report whatever they have; missing fields are best-effort. The
 * orchestrator uses the `sandboxId` for cross-reference against the local
 * `state.json` to detect orphans.
 */
export interface CloudSandboxSummary {
  sandboxId: string;
  /** User-facing sandbox name (when the backend records one). */
  name?: string;
  /** ISO-8601 sandbox creation time, when known. */
  createdAt?: string;
  /** Coarse runtime state — same vocabulary as `state()`. */
  state?: CloudState;
}

export interface CloudBackend {
  readonly name: string;

  /**
   * Port the in-box WebProxy binds and that the provider exposes + treats as the
   * box's "web" port (what `resolveUrl(kind:'web')` resolves and `agentbox url`
   * opens). Defaults to `CLOUD_WEB_PROXY_PORT` (80) when absent — docker/hetzner/
   * daytona reach the WebProxy on :80. Vercel rejects privileged ports (<1024)
   * and can't add ports to a running sandbox, so it sets this to a non-privileged
   * port (8080) that is exposed at create; the value is also wired to the in-box
   * ctl via AGENTBOX_WEB_PROXY_PORT so the WebProxy binds the same port.
   */
  readonly webProxyPort?: number;

  provision(req: CloudProvisionRequest): Promise<CloudHandle>;
  /** Resolve an existing sandbox by id; null when it no longer exists. */
  get(sandboxId: string): Promise<CloudHandle | null>;
  /**
   * Optional: enumerate every sandbox the configured credentials can see.
   * Used by `agentbox prune --provider <name>` to surface orphans. Backends
   * without a list primitive omit it and prune falls back to "nothing to
   * report".
   */
  list?(): Promise<CloudSandboxSummary[]>;

  start(h: CloudHandle): Promise<void>;
  stop(h: CloudHandle): Promise<void>;
  /** Pause semantics: cold storage (Daytona archive); backends without pause map it to stop. */
  pause(h: CloudHandle): Promise<void>;
  resume(h: CloudHandle): Promise<void>;
  destroy(h: CloudHandle): Promise<void>;
  state(h: CloudHandle): Promise<CloudState>;

  exec(h: CloudHandle, cmd: string, opts?: CloudExecOptions): Promise<CloudExecResult>;

  uploadFile(h: CloudHandle, localPath: string, remotePath: string): Promise<void>;
  downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void>;
  listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]>;

  /** Token-authed public URL for an exposed in-box port. See `CloudPreviewUrl`. */
  previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl>;

  /**
   * Optional: invalidate whatever cached transport state powers a previous
   * `previewUrl(h, port)` and mint a fresh one. Used by the host
   * CloudBoxPoller when the in-process URL stops responding (e.g. an SSH
   * `-L` forward whose ControlMaster died after a host sleep/wake) — without
   * this hook the poller would back off forever against a dead local port.
   *
   * Backends whose preview URL is permanent (Daytona's CloudFront alias)
   * omit this and the poller treats a connection error as a transient blip
   * to back off on. Backends that own the transport (Hetzner's SSH tunnel)
   * implement this to tear down + reopen the master and re-mint the
   * forward. Implementations MUST NOT silently return the same URL — return
   * the new one (which may differ from the prior URL).
   */
  refreshPreviewUrl?(h: CloudHandle, port: number): Promise<CloudPreviewUrl>;

  /**
   * Browser-bound signed preview URL with the auth token embedded in the URL
   * (no header needed). Used for `agentbox url` / `agentbox screen` — anywhere
   * the host hands the URL off to a browser. Distinct from `previewUrl()`
   * because the two token kinds are not interchangeable on Daytona: standard
   * tokens go in `x-daytona-preview-token`; signed tokens are baked into the
   * URL itself and can't be swapped for a header value. `expiresInSeconds` is
   * provider-clamped (Daytona: 1s–86400s).
   *
   * Optional: backends without a signed-URL primitive omit this and callers
   * must surface a header-token workaround (today: error out clearly).
   */
  signedPreviewUrl?(h: CloudHandle, port: number, expiresInSeconds: number): Promise<CloudPreviewUrl>;

  /**
   * Optional: SSH connect argv for an interactive attach. Returns argv where
   * `argv[0]` is the program (e.g. `'ssh'`) and the rest are connection args
   * (user@host, options). `@agentbox/sandbox-cloud`'s `buildAttach` appends a
   * `-t '<inner-command>'` to run the right thing inside the sandbox (a tmux
   * session, a log tail, …). Async because most backends mint a short-lived
   * SSH token per call. When absent, `sandbox-cloud` falls back to an
   * exec-driven tmux pump.
   */
  attachArgv?(h: CloudHandle): Promise<string[]>;
  /** Optional: best-effort cleanup of a token minted by `attachArgv`. */
  revokeAttachToken?(h: CloudHandle, argv: string[]): Promise<void>;

  /**
   * Optional: get-or-create a persistent volume by name and return an opaque
   * id that callers thread into `CloudProvisionRequest.volumes[i].volumeId`.
   * Backends without a volume API omit this; callers detect the absence with
   * `typeof backend.ensureVolume === 'function'` and degrade gracefully (e.g.
   * fall back to per-sandbox seeding).
   */
  ensureVolume?(name: string): Promise<{ volumeId: string }>;

  /**
   * Optional: capture the running sandbox's filesystem into a named provider
   * snapshot. Daytona maps this to `sb._experimental_createSnapshot(name)`
   * (the only SDK method that captures live state). The resulting snapshot
   * becomes a separate org-scoped artifact that future `provision()` calls
   * can boot from via `CloudProvisionRequest.snapshot`. Names must be unique
   * within the provider's namespace — callers usually prefix them with a
   * project-hash to avoid collisions.
   *
   * Backends without a snapshot primitive omit this; the cloud provider's
   * `checkpoint.create` then throws a clear "not supported" error.
   */
  createSnapshot?(h: CloudHandle, snapshotName: string): Promise<void>;

  /**
   * Optional: delete a named provider snapshot. Idempotent — a missing
   * snapshot must resolve cleanly without throwing (matches the
   * `destroy()` "already gone" semantics).
   */
  deleteSnapshot?(snapshotName: string): Promise<void>;

  /**
   * Optional: report whether a named provider snapshot is still bootable.
   * Used to detect a stale cloud-checkpoint (the snapshot expired or was
   * deleted out-of-band) *before* a `provision()` would 410 on it — so the
   * caller can prune the dangling local manifest and re-ask the setup wizard
   * instead of crashing mid-create. Must return `false` (never throw) for a
   * missing / deleted / failed snapshot, and `true` only for one that can
   * actually boot a sandbox.
   */
  snapshotExists?(snapshotName: string): Promise<boolean>;

  /**
   * Optional: bring up a `portless` proxy *inside the sandbox* that mirrors
   * the host's Portless setup, so `https://<boxName>.localhost` resolves to
   * the same content from both the host browser and the in-box browser.
   *
   * Only meaningful for backends whose `previewUrl()` returns a loopback URL
   * (Hetzner — the host is reached via `ssh -L 127.0.0.1:<ephemeral>`). Cloud
   * backends that surface a public URL (Daytona) omit this; their URL is
   * already reachable from both sides.
   *
   * `proxyPort` + `tls` should match the host's portless mode so the URL is
   * literally identical on both sides; `webPort` is the in-box port to alias
   * to (the cloud WebProxy listens here).
   *
   * Best-effort: a failure logs but does not break create/start. Idempotent
   * — a portless proxy already up on the port should be reused.
   */
  startInBoxPortless?(
    h: CloudHandle,
    opts: { boxName: string; proxyPort: number; tls: boolean; webPort: number },
  ): Promise<void>;

  /**
   * Optional: push the sandbox's session-timeout death-time forward so an
   * actively-working in-box agent isn't killed when the create-time timeout
   * elapses. The host renewal loop (`@agentbox/relay` cloud-keepalive) calls
   * this while the agent is active, anchoring the death-time at
   * `lastActivity + window` (window = the autopause idle threshold).
   *
   * Both an absolute `targetDeadlineEpochMs` AND the host's tracked
   * `currentDeadlineEpochMs` are passed because the SDKs differ:
   *   - vercel: `sb.extendTimeout(ms)` is ADDITIVE and the remaining time isn't
   *     readable, so the backend extends by `targetDeadlineEpochMs -
   *     currentDeadlineEpochMs` (the host owns the deadline bookkeeping).
   *   - e2b: `Sandbox.setTimeout(ms)` SETS the TTL to `ms` from now, so the
   *     backend uses `targetDeadlineEpochMs - Date.now()` and ignores
   *     `currentDeadlineEpochMs`.
   * Both clamp the computed duration to `>= 0`.
   *
   * The host only calls when `target > current`, so this never shortens a
   * session. Plan-cap rejection (Hobby ~45m, Pro+ ~5h) MUST surface (throw or
   * no-op) — the host loop swallows it and lets the box lapse at the cap.
   * Backends without a renew primitive omit this; the loop detects the absence
   * with `typeof backend.renewTimeout === 'function'` and skips the box.
   */
  renewTimeout?(
    h: CloudHandle,
    targetDeadlineEpochMs: number,
    currentDeadlineEpochMs: number,
  ): Promise<void>;
}
