import { randomBytes } from 'node:crypto';
import { execInBox } from './docker.js';

export interface VncLaunchResult {
  up: boolean;
  reason?: string;
}

/**
 * Spawn the in-container VNC supervisor (`/usr/local/bin/agentbox-vnc-start`)
 * detached, then poll the container's TCP 6080 to confirm websockify is up.
 * Best-effort, mirroring {@link launchCtlDaemon} — failure is logged but
 * doesn't fail box creation. The password reaches the script through the
 * container's AGENTBOX_VNC_PASSWORD env, set at `docker run` time, so we don't
 * need `-e` on the exec (and the re-launch path on `agentbox start` works
 * without it too).
 */
export async function launchVncDaemon(
  container: string,
  timeoutMs = 5000,
): Promise<VncLaunchResult> {
  const result = await execInBox(container, ['/usr/local/bin/agentbox-vnc-start'], {
    user: 'vscode',
    detach: true,
  });
  if (result.exitCode !== 0) {
    return { up: false, reason: `docker exec failed: ${result.stderr || result.stdout}` };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await execInBox(
      container,
      ['bash', '-lc', '(echo > /dev/tcp/127.0.0.1/6080) 2>/dev/null'],
      { user: 'vscode' },
    );
    if (probe.exitCode === 0) return { up: true };
    await new Promise((r) => setTimeout(r, 150));
  }
  return { up: false, reason: `websockify did not bind 6080 within ${String(timeoutMs)}ms` };
}

const VNC_PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 8-char password from a 62-symbol alphabet. The 8-char cap is a real RFB
 * protocol limit — VncAuth truncates at compare time, so longer passwords give
 * no security gain. 62^8 ≈ 47 bits; adequate for the loopback-bound surface
 * we expose (host port pinned to 127.0.0.1 + OrbStack's name-based routing,
 * neither of which is reachable from off-host without explicit tunnelling).
 */
export function generateVncPassword(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += VNC_PASSWORD_ALPHABET[bytes[i]! % VNC_PASSWORD_ALPHABET.length];
  }
  return out;
}

/**
 * Container port the VNC web client (noVNC) binds inside the box. Fixed today;
 * stored on BoxRecord for future-proofing if we ever support multiple displays.
 */
export const VNC_CONTAINER_PORT = 6080;

export interface VncUrls {
  /** OrbStack name-based URL, e.g. http://agentbox-foo.orb.local:6080/... Present only on OrbStack hosts. */
  orbUrl?: string;
  /** Loopback URL via the auto-allocated host port, e.g. http://127.0.0.1:54321/... Present whenever vncHostPort is known. */
  loopbackUrl?: string;
}

/**
 * Build the noVNC URLs for a box, given the box record + (host engine).
 * `engine === 'orbstack'` triggers the `<container>.orb.local:6080` route;
 * either engine produces the loopback URL when the host port is resolved.
 * Returns an empty object when VNC isn't enabled or the password isn't known.
 */
export function buildVncUrls(
  record: {
    container: string;
    vncEnabled?: boolean;
    vncHostPort?: number;
    vncContainerPort?: number;
    vncPassword?: string;
  },
  engine: 'orbstack' | 'docker-desktop' | 'other',
): VncUrls {
  if (!record.vncEnabled || !record.vncPassword) return {};
  const containerPort = record.vncContainerPort ?? VNC_CONTAINER_PORT;
  const qs = `autoconnect=1&password=${encodeURIComponent(record.vncPassword)}`;
  const urls: VncUrls = {};
  if (engine === 'orbstack') {
    urls.orbUrl = `http://${record.container}.orb.local:${String(containerPort)}/vnc.html?${qs}`;
  }
  if (record.vncHostPort) {
    urls.loopbackUrl = `http://127.0.0.1:${String(record.vncHostPort)}/vnc.html?${qs}`;
  }
  return urls;
}
