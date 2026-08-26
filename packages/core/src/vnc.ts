/**
 * In-box port websockify serves the noVNC client on. Fixed by Dockerfile.box and
 * mirrored by `CLOUD_VNC_PORT` in @agentbox/sandbox-cloud.
 */
export const NOVNC_PORT = 6080;

/**
 * The complete noVNC viewer URL for a box: `<base>/vnc.html?autoconnect=1&password=…`.
 *
 * `base` is a scheme+host(+port) origin — a Portless alias, an OrbStack name, a
 * loopback host port, or a cloud provider's signed preview URL. Trailing slashes
 * are stripped so the concat stays canonical, and the password is URL-encoded
 * (generateVncPassword's alphabet is already safe, a hand-set one may not be).
 */
export function buildNoVncUrl(base: string, password: string): string {
  return `${base.replace(/\/+$/, '')}/vnc.html?autoconnect=1&password=${encodeURIComponent(password)}`;
}
