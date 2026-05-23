/**
 * `CloudBackend` — the thin SDK-level interface a cloud provider implements.
 * Just the primitives: provision a sandbox, exec, move files, lifecycle,
 * preview URLs. Everything else (relay wiring, workspace/git seeding, agent
 * config sync, the in-box supervisor, the host poller) is composed once by
 * `@agentbox/sandbox-cloud`'s `createCloudProvider(backend)` and reused by
 * every cloud backend. Adding a new cloud is then ~one file implementing this.
 */

export interface CloudProvisionRequest {
  name: string;
  /** Resolved base image / snapshot ref. */
  image: string;
  resources?: { cpu?: number; memory?: number; disk?: number };
  /** Env vars baked into the sandbox at provision time. */
  env?: Record<string, string>;
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
   * Optional: argv for an interactive attach (SSH). When absent,
   * `@agentbox/sandbox-cloud` falls back to an exec-driven tmux pump.
   */
  attachArgv?(h: CloudHandle): string[] | null;
}
