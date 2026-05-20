export type BoxId = string;

export type BoxState = 'running' | 'paused' | 'stopped' | 'destroyed' | 'missing';

export type AgentKind = 'claude-code' | 'codex' | (string & {});

export interface BoxDescriptor {
  id: BoxId;
  state: BoxState;
  agent: AgentKind;
  workspacePath: string;
  createdAt: Date;
}

export interface StartBoxOptions {
  workspacePath: string;
  agent: AgentKind;
}

export interface BoxResourceLimits {
  /** Hard memory ceiling in bytes. null = unlimited. */
  memoryBytes: number | null;
  /** Fractional CPU count (docker --cpus). null = unlimited. */
  cpus: number | null;
  /** Max PIDs in the box's pid cgroup. null = unlimited. */
  pidsLimit: number | null;
  /**
   * Raw disk size string as accepted by the engine (e.g. "10G"). Best-effort:
   * a no-op on overlay2 / the macOS engines. null = unset.
   */
  disk: string | null;
}

export interface BoxResourceStats {
  /** Provider that produced these numbers (e.g. "docker"). */
  source: string;
  /** Live sample; false when the box is paused/stopped (limits-only). */
  live: boolean;
  cpuPercent: number | null;
  memUsedBytes: number | null;
  /** Effective ceiling: applied limit, else engine total. */
  memLimitBytes: number | null;
  memPercent: number | null;
  pids: number | null;
  /** PER-BOX writable surface: container writable layer (where /workspace lives) + the in-box dockerd's data-root volume. */
  diskUsedBytes: number | null;
  /** Per-box --host-snapshot APFS clone dir; null when none. */
  snapshotDiskBytes: number | null;
  /** Size of the checkpoint image this box was started from; null when the box is not from a checkpoint. */
  checkpointVolumeBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  limits: BoxResourceLimits;
  /** Non-fatal notes (e.g. "disk size is a no-op on overlay2"). */
  warnings: string[];
}

export interface SandboxProvider {
  readonly name: string;
  start(opts: StartBoxOptions): Promise<BoxDescriptor>;
  pause(id: BoxId): Promise<void>;
  resume(id: BoxId): Promise<void>;
  stop(id: BoxId): Promise<void>;
  destroy(id: BoxId): Promise<void>;
  list(): Promise<BoxDescriptor[]>;
  /** Optional: not all providers expose live resource metrics. */
  stats?(id: BoxId): Promise<BoxResourceStats>;
}
