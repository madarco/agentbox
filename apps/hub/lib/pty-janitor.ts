import { listPtySessions, ptyLogPath, removePtySession } from '@agentbox/sandbox-core';
import { ptyHostAlive } from '@agentbox/relay';

/**
 * Sweep the leftovers of pty hosts that are gone.
 *
 * A pty host outlives the hub on purpose, so nothing in memory knows which
 * sessions exist — the directory is the registry. A host that crashed (or was
 * killed with the machine) leaves its socket and meta behind, and a stale
 * socket makes a session look alive to anything that only reads the directory.
 *
 * Conservative by design: it removes a session's files only when BOTH the
 * socket refuses a connection and the recorded pid is gone. Either alone can be
 * a live host (a busy socket, a pid that means nothing after a reboot).
 */
export interface PtyJanitorOptions {
  intervalMs: number;
  warn?: (line: string) => void;
  /** Injected in tests. */
  isPidAlive?: (pid: number) => boolean;
  baseDir?: string;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: someone else's process holds the pid — alive, just not ours.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function sweepPtySessions(opts: PtyJanitorOptions): Promise<string[]> {
  const alive = opts.isPidAlive ?? defaultIsPidAlive;
  const swept: string[] = [];
  for (const meta of await listPtySessions(opts.baseDir)) {
    if (alive(meta.pid)) continue;
    if (await ptyHostAlive(meta.socket)) continue;
    await removePtySession(meta.managerId, opts.baseDir).catch(() => {});
    swept.push(meta.managerId);
    opts.warn?.(
      `swept the leftovers of pty host ${meta.managerId} (pid ${String(meta.pid)} is gone); see ${ptyLogPath(meta.managerId, opts.baseDir)}`,
    );
  }
  return swept;
}

/** Start the periodic sweep; returns a stop function. */
export function startPtyJanitor(opts: Partial<PtyJanitorOptions> = {}): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const tick = (): void => {
    void sweepPtySessions({ ...opts, intervalMs }).catch(() => {});
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  // Never a reason to keep the hub alive.
  timer.unref();
  return () => clearInterval(timer);
}
