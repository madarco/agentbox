import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { bashScript, quoteShellArg } from './shell.js';

/**
 * Launch the in-box VNC stack (Xvnc + websockify + noVNC) inside a cloud
 * sandbox. The image (built from `Dockerfile.box`) bakes
 * `/usr/local/bin/agentbox-vnc-start`, which is generic bash that reads
 * `AGENTBOX_VNC_PASSWORD` from env and is idempotent — re-running while the
 * daemons are alive is a no-op, so `start()` can blindly call us again.
 *
 * The password is injected inline at every exec call rather than baked into
 * the sandbox's provision-time `envVars`, so a Daytona stop/start doesn't
 * depend on Daytona preserving env across lifecycle transitions. Same shape
 * as `launchCloudCtlDaemon`.
 */
export interface LaunchCloudVncArgs {
  backend: CloudBackend;
  handle: CloudHandle;
  vncPassword: string;
}

export async function launchCloudVncDaemon(args: LaunchCloudVncArgs): Promise<void> {
  // The script binds Xvnc on :5901 (loopback) and websockify on 0.0.0.0:6080.
  // We poll 6080 from inside the sandbox via bash's /dev/tcp pseudo-device —
  // the host can't reach the sandbox port directly (signed preview URLs are
  // public but high-latency and rate-limited, not the right path for a
  // readiness probe). Bound the probe so a wedged daemon surfaces an error.
  //
  // `cd /home/vscode` is load-bearing: Daytona's `executeCommand` runs us
  // from a transient CWD that doesn't necessarily exist by the time the
  // backgrounded websockify (Python) reads `os.getcwd()` for its default
  // cert path resolution. A stable CWD inside the sandbox user's home
  // avoids a `FileNotFoundError` at websockify startup.
  const script = [
    `set -e`,
    `cd /home/vscode`,
    `export AGENTBOX_VNC_PASSWORD=${quoteShellArg(args.vncPassword)}`,
    `mkdir -p /var/log/agentbox 2>/dev/null || true`,
    `nohup /usr/local/bin/agentbox-vnc-start >> /var/log/agentbox/vnc-start.log 2>&1 &`,
    `disown`,
    // Probe for websockify to bind 6080. ~15s ceiling: E2B's Python venv
    // startup (websockify is a pure-python proxy launched from a venv) takes
    // ~7-9s before the socket binds, so a 5s ceiling false-negatives every
    // create. Docker/hetzner/daytona/vercel come up well inside this window.
    `for _ in $(seq 1 150); do`,
    `  if (echo > /dev/tcp/127.0.0.1/6080) 2>/dev/null; then echo ready; exit 0; fi`,
    `  sleep 0.1`,
    `done`,
    `echo "websockify did not bind 6080 within 15s" >&2`,
    `exit 1`,
  ].join('\n');

  const r = await args.backend.exec(args.handle, bashScript(script));
  if (r.exitCode !== 0) {
    throw new Error(`agentbox-vnc-start failed: ${r.stderr || r.stdout}`);
  }
}
