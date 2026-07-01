/**
 * `SyncTransport` — the one seam that turns "every sync path branches on
 * provider" into "one interface, two implementations". It is a dumb,
 * direction-symmetric byte mover bound to a single box/handle at construction;
 * ALL the smart logic (what to stage, exclude, transform, when to skip) lives in
 * the concern modules that call it.
 *
 * Two implementations satisfy it:
 *  - `DockerSyncTransport` (`@agentbox/sandbox-docker`) — wraps the existing
 *    `docker exec … tar` / rsync-helper-container primitives.
 *  - `CloudSyncTransport` (`@agentbox/sandbox-cloud`) — wraps a `CloudBackend`
 *    (`exec` / `uploadFile` / `downloadFile`).
 *
 * Provider-specific quirks (Daytona FUSE `cp`-not-`tar`, the vercel/e2b root
 * carve-out, codex Keychain warnings) live INSIDE the two impls, never in the
 * concern logic.
 */

export interface SyncExecOptions {
  user?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Per-attempt wall-clock cap (slow FUSE-volume extracts). */
  attemptTimeoutMs?: number;
  /** Disable retries when the command is not safely idempotent under retry. */
  noRetry?: boolean;
}

export interface SyncExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Ownership/permission knobs shared by every host→box push. Mirrors what the
 * docker `copyOneEntry` and cloud `uploadOneEntry` bodies apply today.
 */
export interface PushOptions {
  /** tar `--exclude` patterns applied when packing a dir. */
  exclude?: string[];
  /** chown target uid inside the box. Default 1000 (`vscode`); 0 leaves root. */
  uid?: number;
  /** chmod -R applied after extract. */
  mode?: number;
  /**
   * Extract with `--no-same-permissions --no-same-owner -m` (default true).
   * Set false only when the source tree's own modes/owners must be preserved.
   */
  noSamePerms?: boolean;
}

/** One host source dir to rsync into a persistent volume (docker helper container). */
export interface VolumeHostSource {
  hostDir: string;
  /** Sub-path under the volume mount to land this source at (''=root). */
  destSubpath: string;
  exclude?: string[];
  /** rsync `--update` (newest-wins) — e.g. opencode `model.json`. */
  update?: boolean;
}

/**
 * Capability flags a concern reads instead of branching on provider name. E.g.
 * the credentials concern uses `ephemeralFs` to decide marker-gated seed vs
 * push-every-create; the static-config step uses `helperContainer` to decide
 * rsync-into-volume vs "already baked into the snapshot at prepare time".
 */
export interface TransportCaps {
  /** Static config persists in a volume across boxes (docker shared vol, daytona vol). */
  persistentVolumes: boolean;
  /** A throwaway helper container can rsync host→volume without a running box (docker). */
  helperContainer: boolean;
  /** Per-box FS is ephemeral → credentials must be re-pushed every create (e2b/vercel/hetzner). */
  ephemeralFs: boolean;
}

export interface SyncTransport {
  readonly caps: TransportCaps;

  exec(cmd: string[], opts?: SyncExecOptions): Promise<SyncExecResult>;

  // ---- host → box ----
  /**
   * Extract a host-built tarball into `boxDestDir` — the unified host→box
   * primitive concerns stage a (filtered) tarball for. Docker streams it into
   * `tar -xf -` (honoring `opts.uid` via `--user`); cloud uploads it then
   * `backend.exec('tar -xf … --no-same-permissions --no-same-owner -m')`. Each
   * impl keeps its own extract flags so behavior is byte-identical to today.
   */
  applyTarball(hostTarPath: string, boxDestDir: string, opts?: PushOptions): Promise<void>;
  pushTree(hostSrcDir: string, boxDestDir: string, opts?: PushOptions): Promise<void>;
  pushFile(hostSrcPath: string, boxDestPath: string, opts?: PushOptions): Promise<void>;

  // ---- box → host (first-class, not an afterthought) ----
  pullTree(boxSrcDir: string, hostDestDir: string, opts?: { exclude?: string[] }): Promise<void>;
  pullFile(boxSrcPath: string, hostDestPath: string): Promise<void>;
  /** Read a single box file as text; null when absent. The `cat`-based extract. */
  readText(boxPath: string): Promise<string | null>;

  // ---- optional persistent-volume seam (docker helper container + daytona volume) ----
  ensureVolume?(name: string): Promise<{ volumeId: string }>;
  /**
   * Seed a persistent volume directly from host dirs (docker's throwaway
   * rsync-helper-container). Cloud omits this — its static config is baked into
   * the snapshot at `prepare` time, so `caps.helperContainer` is false there.
   */
  seedVolumeFromHost?(volume: string, sources: VolumeHostSource[]): Promise<void>;
}
