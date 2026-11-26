// A box's final history flush (docs/agent-history-plan.md, Phase 1; stop and
// pause since usage-dashboard Phase 4a): ship whatever the box's bound sessions
// still hold before the box goes away or goes quiet. Docker transcripts are read
// host-side by the relay; everything else (other providers' transcripts, every
// provider's memory) by the in-box shipper, once. Time-boxed and best-effort:
// losing history must never block a lifecycle action.
import type { BoxRecord, ExecOptions, ExecResult } from '@agentbox/core';

/** What the flush precedes. Only a destroy settles the relay's docker reads for good. */
export type HistoryFlushReason = 'destroy' | 'stop' | 'pause';

export const HISTORY_FLUSH_TIMEOUT_MS = 90_000;
/** How long a docker destroy waits for the in-box flush before the relay read starts. */
export const DOCKER_IN_BOX_FIRST_MS = 20_000;
/**
 * A stop or pause waits less: the user is waiting on it, and the box comes back
 * (a later pass or the destroy's flush ships what this one missed).
 */
export const CLOSE_FLUSH_TIMEOUT_MS = 30_000;
export const CLOSE_IN_BOX_FIRST_MS = 10_000;

export interface HistoryFlushDeps {
  /** The relay's docker shipper, when this hub has history enabled. */
  relayHistory?: {
    flushBox(boxId: string): Promise<unknown>;
    /** Abort the box's docker reads and remove flush helpers holding its volumes. */
    settleBox(boxId: string): Promise<void>;
  };
  exec(box: BoxRecord, argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** The provider's cheap state probe: a cloud box is flushed only when running. */
  probeState(box: BoxRecord): Promise<string>;
  log(line: string): void;
  /** Default `destroy`. */
  reason?: HistoryFlushReason;
  /**
   * Started after the flush (or its timeout) with what it shipped already
   * ingested, so the usage stats can pick up the tail. Not awaited: the
   * lifecycle action does not wait on a stats refresh.
   */
  afterFlush?: () => Promise<unknown>;
  timeoutMs?: number;
  /** Tests: the docker in-box flush's head start (default `DOCKER_IN_BOX_FIRST_MS`). */
  inBoxFirstMs?: number;
}

export async function flushBoxHistory(box: BoxRecord, deps: HistoryFlushDeps): Promise<void> {
  if (!deps.relayHistory) return;
  const reason = deps.reason ?? 'destroy';
  const destroying = reason === 'destroy';
  const goOn = destroying
    ? 'destroying anyway'
    : `${reason === 'stop' ? 'stopping' : 'pausing'} anyway`;
  const isDocker = (box.provider ?? 'docker') === 'docker';
  // A paused or stopped cloud box is not woken for its history: resuming bills
  // and boots it, and its last turn was shipped before it went idle unless it
  // was cut off mid-pass. A docker box is read host-side in any state.
  // The in-box flush ships memory on every provider (memory is on the box's own
  // disk) and transcripts on the non-docker ones. It needs a running box.
  const inBox = deps.probeState(box).then(async (state) => {
    if (state !== 'running') {
      if (!isDocker) deps.log(`history: ${box.name} is ${state}; skipping the final flush`);
      return;
    }
    const r = await deps.exec(box, ['agentbox-ctl', 'history', 'flush']);
    if (r.exitCode !== 0) {
      deps.log(`history: final flush of ${box.name} exited ${String(r.exitCode)}`);
    }
  });
  // Docker: in-box first, then the relay's read. The in-box flush also runs
  // the sqlite row cursor (opencode), whose last rows the relay then ships.
  // Capped, so a slow in-box flush cannot spend the relay read's budget.
  const relayHistory = deps.relayHistory;
  const inBoxCap = new Promise<void>((resolve) => {
    setTimeout(
      resolve,
      deps.inBoxFirstMs ?? (destroying ? DOCKER_IN_BOX_FIRST_MS : CLOSE_IN_BOX_FIRST_MS),
    ).unref();
  });
  const work = isDocker
    ? Promise.race([inBox.catch(() => undefined), inBoxCap]).then(() =>
        relayHistory.flushBox(box.id),
      )
    : inBox;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(
      () => resolve('timeout'),
      deps.timeoutMs ?? (destroying ? HISTORY_FLUSH_TIMEOUT_MS : CLOSE_FLUSH_TIMEOUT_MS),
    );
  });
  try {
    const r = await Promise.race([work.then(() => 'done' as const), timeout]);
    if (r === 'timeout') deps.log(`history: final flush of ${box.name} timed out; ${goOn}`);
  } catch (e) {
    deps.log(
      `history: final flush of ${box.name} failed (${e instanceof Error ? e.message : String(e)}); ${goOn}`,
    );
  } finally {
    clearTimeout(timer);
  }
  // A timed-out docker flush is still running, and a helper container it
  // started would make the provider's `docker volume rm` fail (silently,
  // orphaning the volume). Stop it before the teardown starts. A stopped or
  // paused box comes back, so its reads must not be settled for good.
  if (isDocker && destroying) await deps.relayHistory.settleBox(box.id).catch(() => undefined);
  if (deps.afterFlush) {
    void deps.afterFlush().catch((e: unknown) => {
      deps.log(
        `history: after the flush of ${box.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
}
