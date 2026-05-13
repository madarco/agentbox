import { createConnection } from 'node:net';
import type { ReadyProbe } from './config.js';
import type { LogEvent } from './types.js';

export type ProbeResult = 'ready' | 'timed_out' | 'aborted';

export interface ProbeHandle {
  abort: () => void;
  result: Promise<ProbeResult>;
}

export interface ProbeContext {
  /**
   * Required for log_match probes. The runner subscribes its in-line log
   * stream so the probe can scan stdout/stderr without re-reading the log file.
   */
  subscribeLogs?: (cb: (ev: LogEvent) => void) => () => void;
}

/**
 * Start a probe. The handle's `result` resolves to:
 *   'ready'      — probe succeeded
 *   'timed_out'  — overall timeout elapsed without success
 *   'aborted'    — caller called abort()
 *
 * The caller (typically ServiceRunner) decides what to do on timeout — kill
 * the process, mark the service unhealthy, etc. The probe itself doesn't
 * touch any process state.
 */
export function startProbe(probe: ReadyProbe, ctx: ProbeContext): ProbeHandle {
  let settled = false;
  let resolveFn!: (r: ProbeResult) => void;
  const result = new Promise<ProbeResult>((res) => {
    resolveFn = res;
  });

  const cancelers: Array<() => void> = [];

  const settle = (r: ProbeResult): void => {
    if (settled) return;
    settled = true;
    for (const c of cancelers) c();
    cancelers.length = 0;
    resolveFn(r);
  };

  const overall = setTimeout(() => settle('timed_out'), probe.timeoutMs);
  cancelers.push(() => clearTimeout(overall));

  const initialDelay = probe.kind === 'log_match' ? 0 : probe.initialDelayMs;
  const startDelay = setTimeout(() => {
    if (settled) return;
    if (probe.kind === 'port') pollPort();
    else if (probe.kind === 'http') pollHttp();
    else attachLogMatch();
  }, initialDelay);
  cancelers.push(() => clearTimeout(startDelay));

  function pollPort(): void {
    if (settled || probe.kind !== 'port') return;
    const sock = createConnection({
      port: probe.port,
      host: probe.host,
      timeout: Math.min(Math.max(probe.intervalMs * 2, 500), 5000),
    });
    let resolved = false;
    const cleanup = (): void => {
      sock.removeAllListeners();
      sock.destroy();
    };
    cancelers.push(cleanup);
    sock.once('connect', () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      settle('ready');
    });
    sock.once('error', () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (!settled) {
        const t = setTimeout(pollPort, probe.intervalMs);
        cancelers.push(() => clearTimeout(t));
      }
    });
    sock.once('timeout', () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (!settled) {
        const t = setTimeout(pollPort, probe.intervalMs);
        cancelers.push(() => clearTimeout(t));
      }
    });
  }

  function pollHttp(): void {
    if (settled || probe.kind !== 'http') return;
    const controller = new AbortController();
    const perAttempt = setTimeout(() => controller.abort(), 2000);
    cancelers.push(() => {
      clearTimeout(perAttempt);
      controller.abort();
    });
    fetch(probe.url, { signal: controller.signal })
      .then((res) => {
        clearTimeout(perAttempt);
        if (settled) return;
        const ok =
          probe.expectStatus === undefined
            ? res.status >= 200 && res.status < 300
            : res.status === probe.expectStatus;
        if (ok) {
          settle('ready');
        } else {
          const t = setTimeout(pollHttp, probe.intervalMs);
          cancelers.push(() => clearTimeout(t));
        }
      })
      .catch(() => {
        clearTimeout(perAttempt);
        if (settled) return;
        const t = setTimeout(pollHttp, probe.intervalMs);
        cancelers.push(() => clearTimeout(t));
      });
  }

  function attachLogMatch(): void {
    if (settled || probe.kind !== 'log_match') return;
    if (!ctx.subscribeLogs) {
      // No way to receive lines — wait for overall timeout.
      return;
    }
    const unsub = ctx.subscribeLogs((ev) => {
      if (settled) return;
      if (probe.pattern.test(ev.line)) settle('ready');
    });
    cancelers.push(unsub);
  }

  return {
    abort: () => settle('aborted'),
    result,
  };
}
