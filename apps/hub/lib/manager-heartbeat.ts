/**
 * The hub daemon's manager heartbeat.
 *
 * A manager runs on the machine whose folder it sits in; with a control box
 * configured, its RECORD is on the control box, which can probe neither its pid
 * nor its tmux server nor its transcript. So the machine that can do all three
 * says what it sees, on a fixed cadence and after every mutation the backend
 * makes. Without a control box there is nothing to report and the loop is never
 * started.
 *
 * Best-effort by construction: a failed report costs one warning per process
 * (the store's own), and the record simply ages out of its `lastSeenAt` window.
 */
import type { ManagerBackend } from './boxes/backend-types';

export interface ManagerHeartbeatLoop {
  stop(): void;
}

export interface ManagerHeartbeatOptions {
  backend: Pick<ManagerBackend, 'reportManagers'>;
  intervalMs: number;
  /** Called once, the first time a round fails outright. */
  warn?: (message: string) => void;
}

export function startManagerHeartbeats(opts: ManagerHeartbeatOptions): ManagerHeartbeatLoop {
  let running = false;
  let warned = false;

  async function round(): Promise<void> {
    // One round at a time: a slow control box must not stack reports.
    if (running) return;
    running = true;
    try {
      await opts.backend.reportManagers();
    } catch (err) {
      if (!warned) {
        warned = true;
        opts.warn?.(
          `[manager] heartbeat round failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      running = false;
    }
  }

  void round();
  const timer = setInterval(() => void round(), opts.intervalMs);
  // The hub's other timers do the same: a heartbeat must not be the reason the
  // process refuses to exit.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
