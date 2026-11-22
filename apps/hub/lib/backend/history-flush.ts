// A destroy's final history flush (docs/agent-history-plan.md, Phase 1): ship
// whatever the box's bound sessions still hold before the disk goes away.
// Docker transcripts are read host-side by the relay; everything else (other
// providers' transcripts, every provider's memory) by the in-box shipper, once. Time-boxed and best-effort: losing history must never
// block a destroy.
import type { BoxRecord, ExecOptions, ExecResult } from '@agentbox/core';

export const HISTORY_FLUSH_TIMEOUT_MS = 90_000;

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
  timeoutMs?: number;
}

export async function flushBoxHistory(box: BoxRecord, deps: HistoryFlushDeps): Promise<void> {
  if (!deps.relayHistory) return;
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
  const work = isDocker
    ? Promise.all([deps.relayHistory.flushBox(box.id), inBox.catch(() => undefined)])
    : inBox;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.timeoutMs ?? HISTORY_FLUSH_TIMEOUT_MS);
  });
  try {
    const r = await Promise.race([work.then(() => 'done' as const), timeout]);
    if (r === 'timeout')
      deps.log(`history: final flush of ${box.name} timed out; destroying anyway`);
  } catch (e) {
    deps.log(
      `history: final flush of ${box.name} failed (${e instanceof Error ? e.message : String(e)}); destroying anyway`,
    );
  } finally {
    clearTimeout(timer);
  }
  // A timed-out docker flush is still running, and a helper container it
  // started would make the provider's `docker volume rm` fail (silently,
  // orphaning the volume). Stop it before the teardown starts.
  if (isDocker) await deps.relayHistory.settleBox(box.id).catch(() => undefined);
}
