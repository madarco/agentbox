/**
 * Launch the in-sandbox `dockerd` daemon for a cloud box. Mirrors what
 * `launchDockerdDaemon` does for Docker (calls
 * `/usr/local/bin/agentbox-dockerd-start` detached, then polls for the
 * `/var/run/docker.sock` to accept connections), adapted for cloud via
 * `backend.exec`.
 *
 * Daytona sandboxes ship with `CAP_SYS_ADMIN` available (validated by the
 * earlier DinD PoC), so the in-sandbox `dockerd` works once the bundled
 * helper script runs. This is opt-in for cloud — most users don't need
 * an in-sandbox docker.
 */

import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { bashScript } from './shell.js';

export interface CloudDockerdLaunchResult {
  up: boolean;
  reason?: string;
}

export async function launchCloudDockerdDaemon(args: {
  backend: CloudBackend;
  handle: CloudHandle;
  timeoutMs?: number;
}): Promise<CloudDockerdLaunchResult> {
  const timeoutMs = args.timeoutMs ?? 60_000;
  // Spawn detached via `nohup ... &` so the exec's stdout/stderr aren't
  // tied to dockerd's lifetime. Redirect both to the standard agentbox
  // log path so `agentbox logs --daemon` style introspection can pick
  // it up.
  const startScript = [
    `set -euo pipefail`,
    `mkdir -p /var/log/agentbox`,
    `nohup sudo -n /usr/local/bin/agentbox-dockerd-start >> /var/log/agentbox/dockerd.log 2>&1 &`,
    `echo "spawned dockerd"`,
  ].join('\n');
  const launch = await args.backend.exec(args.handle, bashScript(startScript));
  if (launch.exitCode !== 0) {
    return {
      up: false,
      reason: `dockerd launch failed: ${launch.stderr || launch.stdout}`,
    };
  }

  // Poll for the socket. The launch script returns immediately (nohup &);
  // dockerd needs ~5-15s on Daytona to initialize iptables + the storage
  // graphdriver.
  const probeCmd =
    '[ -S /var/run/docker.sock ] && docker -H unix:///var/run/docker.sock info >/dev/null 2>&1';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await args.backend.exec(args.handle, probeCmd);
    if (probe.exitCode === 0) return { up: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    up: false,
    reason: `dockerd did not become ready within ${String(timeoutMs)}ms`,
  };
}
