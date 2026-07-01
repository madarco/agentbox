/**
 * `RecordingSyncTransport` — the parity net for the sync refactor. Every concern
 * module is a pure function of `(ctx, transport, …)`, so a concern's entire
 * observable effect IS its ordered sequence of transport calls. This fake
 * `SyncTransport` records that sequence deterministically — no host FS, no git,
 * no relay, no docker, no randomness — so a concern can be golden-snapshotted
 * and a refactor that changes what we emit fails the snapshot.
 *
 * Mirrors the `MockCloudBackend` (`@agentbox/sandbox-cloud`) pattern: a
 * reference double shipped in `src/` and driven by tests.
 */

import type {
  PushOptions,
  SyncExecOptions,
  SyncExecResult,
  SyncTransport,
  TransportCaps,
  VolumeHostSource,
} from '@agentbox/core';

/** One recorded transport call, in invocation order. */
export interface RecordedOp {
  op:
    | 'exec'
    | 'applyTarball'
    | 'pushTree'
    | 'pushFile'
    | 'pullTree'
    | 'pullFile'
    | 'readText'
    | 'ensureVolume'
    | 'seedVolumeFromHost';
  /** Normalized, snapshot-stable arguments for this call. */
  args: Record<string, unknown>;
}

export interface RecordingTransportOptions {
  /** Override capability flags (default: docker-like). */
  caps?: Partial<TransportCaps>;
  /**
   * Whether the volume primitives are present. Default true (docker-like). Set
   * false to model an ephemeral cloud backend (no `ensureVolume` /
   * `seedVolumeFromHost`), so a concern that feature-detects them takes the
   * push-every-create branch.
   */
  withVolumes?: boolean;
  /** Canned `exec` result. Default `{ exitCode: 0, stdout: '', stderr: '' }`. */
  execResult?: (cmd: string[], opts?: SyncExecOptions) => SyncExecResult;
  /** Canned `readText` responses keyed by box path. Default: null (absent). */
  readText?: (boxPath: string) => string | null;
}

export interface RecordingSyncTransport extends SyncTransport {
  /** Recorded calls in invocation order. */
  readonly ops: ReadonlyArray<RecordedOp>;
  /** Drop the recorded ops (between assertions in one test). */
  clear(): void;
}

const DEFAULT_CAPS: TransportCaps = {
  persistentVolumes: true,
  helperContainer: true,
  ephemeralFs: false,
};

export function makeRecordingTransport(
  opts: RecordingTransportOptions = {},
): RecordingSyncTransport {
  const ops: RecordedOp[] = [];
  const caps: TransportCaps = { ...DEFAULT_CAPS, ...opts.caps };
  const withVolumes = opts.withVolumes ?? true;
  const push = (op: RecordedOp['op'], args: Record<string, unknown>) => ops.push({ op, args });

  const base: SyncTransport = {
    caps,
    async exec(cmd: string[], execOpts?: SyncExecOptions): Promise<SyncExecResult> {
      push('exec', { cmd, opts: execOpts });
      return opts.execResult?.(cmd, execOpts) ?? { exitCode: 0, stdout: '', stderr: '' };
    },
    async applyTarball(hostTarPath: string, boxDestDir: string, o?: PushOptions): Promise<void> {
      push('applyTarball', { hostTarPath, boxDestDir, opts: o });
    },
    async pushTree(hostSrcDir: string, boxDestDir: string, o?: PushOptions): Promise<void> {
      push('pushTree', { hostSrcDir, boxDestDir, opts: o });
    },
    async pushFile(hostSrcPath: string, boxDestPath: string, o?: PushOptions): Promise<void> {
      push('pushFile', { hostSrcPath, boxDestPath, opts: o });
    },
    async pullTree(boxSrcDir: string, hostDestDir: string, o?: { exclude?: string[] }): Promise<void> {
      push('pullTree', { boxSrcDir, hostDestDir, opts: o });
    },
    async pullFile(boxSrcPath: string, hostDestPath: string): Promise<void> {
      push('pullFile', { boxSrcPath, hostDestPath });
    },
    async readText(boxPath: string): Promise<string | null> {
      push('readText', { boxPath });
      return opts.readText?.(boxPath) ?? null;
    },
  };

  if (withVolumes) {
    base.ensureVolume = async (name: string): Promise<{ volumeId: string }> => {
      push('ensureVolume', { name });
      return { volumeId: `vol-${name}` };
    };
    base.seedVolumeFromHost = async (volume: string, sources: VolumeHostSource[]): Promise<void> => {
      push('seedVolumeFromHost', { volume, sources });
    };
  }

  return {
    ...base,
    get ops() {
      return ops;
    },
    clear(): void {
      ops.length = 0;
    },
  };
}
