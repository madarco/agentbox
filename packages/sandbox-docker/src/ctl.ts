import { stat } from 'node:fs/promises';
import { execInBox } from './docker.js';

export interface CtlLaunchResult {
  up: boolean;
  reason?: string;
}

/**
 * In-box path the daemon's stdout/stderr are redirected to. `docker exec -d`
 * discards stdio, so without this redirect a crash on startup leaves no trace
 * — the unix socket file lingers (Node doesn't auto-unlink on exit) and any
 * later `agentbox-ctl <op>` connect gets ECONNREFUSED with no log to explain
 * why. The file lives in the container's writable layer; it survives
 * stop/start and is wiped on destroy.
 */
const CTL_DAEMON_LOG = '/var/log/agentbox/ctl-daemon.log';

/**
 * Spawn `agentbox-ctl daemon` detached inside the container and wait briefly
 * for the unix socket to appear on the host-mounted path. Best-effort —
 * failure is logged but doesn't fail box creation, since a missing or empty
 * agentbox.yaml is a perfectly valid state.
 */
export async function launchCtlDaemon(
  container: string,
  hostSocketPath: string,
  timeoutMs = 3000,
): Promise<CtlLaunchResult> {
  // Wrap in `sh -c` so the daemon's stdio lands in a log file we can read
  // after a crash. The log dir is pre-created in the image (Dockerfile.box
  // mkdir+chown vscode); `mkdir -p` is a cheap belt-and-braces. `exec` lets
  // the shell replace itself with the daemon for a clean process tree.
  //
  // Idempotent: skip the spawn when a daemon is already running — a normal
  // `start` runs on a freshly-started container (daemon dead, so this no-ops),
  // but `reconnect` (and `start` on an already-running container) would
  // otherwise launch a duplicate. Anchor the pattern at end-of-cmdline so it
  // matches the daemon (`node …/agentbox-ctl daemon`) but not this `sh -c`
  // wrapper, whose argv ends in the log redirect, not "daemon".
  const logDir = CTL_DAEMON_LOG.replace(/\/[^/]*$/, '');
  const wrapped =
    `mkdir -p ${logDir} && ` +
    `{ pgrep -f 'agentbox-ctl daemon$' >/dev/null 2>&1 && exit 0; }; ` +
    `exec agentbox-ctl daemon >>${CTL_DAEMON_LOG} 2>&1`;
  const result = await execInBox(container, ['sh', '-c', wrapped], {
    user: 'vscode',
    detach: true,
  });
  if (result.exitCode !== 0) {
    return { up: false, reason: `docker exec failed: ${result.stderr || result.stdout}` };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(hostSocketPath)) return { up: true };
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    up: false,
    reason: `socket ${hostSocketPath} did not appear within ${String(timeoutMs)}ms`,
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
