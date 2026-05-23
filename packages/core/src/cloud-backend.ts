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

export interface CloudBackend {
  readonly name: string;

  provision(req: CloudProvisionRequest): Promise<CloudHandle>;
  /** Resolve an existing sandbox by id; null when it no longer exists. */
  get(sandboxId: string): Promise<CloudHandle | null>;

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
}
