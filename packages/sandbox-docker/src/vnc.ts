import { randomBytes } from 'node:crypto';
import { buildNoVncUrl, type BoxRecord, type Provider } from '@agentbox/core';
import { execInBox } from './docker.js';
import { detectEngine } from './sync/host-export.js';

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

export interface VncViewerOptions {
  /** Docker only: prefer the raw `127.0.0.1:<host port>` URL over Portless/OrbStack. */
  loopback?: boolean;
  /** Cloud only: signed-URL lifetime in seconds (the provider's default when unset). */
  ttl?: number;
}

export interface VncUrls {
  /** OrbStack name-based URL, e.g. http://agentbox-foo.orb.local:6080/... Present only on OrbStack hosts. */
  orbUrl?: string;
  /** Loopback URL via the auto-allocated host port, e.g. http://127.0.0.1:54321/... Present whenever vncHostPort is known. */
  loopbackUrl?: string;
  /** Portless URL, e.g. https://vnc-mybox.localhost/vnc.html?... Present when `portlessVncAlias` is set on the record. */
  portlessUrl?: string;
}

/**
 * Build the noVNC URLs for a box, given the box record + (host engine).
 * `engine === 'orbstack'` triggers the `<container>.orb.local:6080` route;
 * a stored Portless alias gives `vnc-<name>.localhost`; either engine
 * produces the loopback URL when the host port is resolved.
 * Returns an empty object when VNC isn't enabled or the password isn't known.
 */
export function buildVncUrls(
  record: {
    container?: string;
    vncEnabled?: boolean;
    vncHostPort?: number;
    vncContainerPort?: number;
    vncPassword?: string;
    portlessVncAlias?: string;
    portlessVncUrl?: string;
  },
  engine: 'orbstack' | 'docker-desktop' | 'other',
): VncUrls {
  if (!record.vncEnabled || !record.vncPassword) return {};
  const containerPort = record.vncContainerPort ?? VNC_CONTAINER_PORT;
  const pw = record.vncPassword;
  const urls: VncUrls = {};
  if (engine === 'orbstack' && record.container) {
    urls.orbUrl = buildNoVncUrl(
      `http://${record.container}.orb.local:${String(containerPort)}`,
      pw,
    );
  }
  if (record.vncHostPort) {
    urls.loopbackUrl = buildNoVncUrl(`http://127.0.0.1:${String(record.vncHostPort)}`, pw);
  }
  if (record.portlessVncAlias) {
    urls.portlessUrl = buildNoVncUrl(
      record.portlessVncUrl ?? `https://${record.portlessVncAlias}.localhost`,
      pw,
    );
  }
  return urls;
}

/**
 * The host-openable noVNC viewer URL for ANY box — the one place that knows a
 * docker box's URL comes off its record while a cloud box's must be minted.
 *
 * Pure URL resolution: no lifecycle side effects, no in-box browser prep (the
 * callers layer those on). Cloud signed URLs expire, so this is called at click
 * time rather than persisted on the record.
 *
 * The docker branch can't go through `provider.resolveUrl({ kind: 'vnc' })` —
 * the docker provider ignores `kind` and always returns the box's *web* URL.
 */
export async function resolveVncViewerUrl(
  box: BoxRecord,
  provider: Provider,
  opts: VncViewerOptions = {},
): Promise<string> {
  if (!box.vncEnabled) {
    throw new Error(`VNC is disabled for box ${box.name} — recreate without \`--no-vnc\``);
  }
  if (!box.vncPassword) {
    throw new Error(
      `box ${box.name} has no VNC password recorded — recreate it to enable the desktop`,
    );
  }

  if ((box.provider ?? 'docker') === 'docker') {
    const urls = buildVncUrls(box, await detectEngine());
    const resolved = opts.loopback
      ? urls.loopbackUrl
      : (urls.portlessUrl ?? urls.orbUrl ?? urls.loopbackUrl);
    if (!resolved) {
      throw new Error(`VNC URL unavailable for box ${box.name} — the daemon may not be up`);
    }
    return resolved;
  }

  const base = await provider.resolveUrl(box, {
    kind: 'vnc',
    ...(opts.ttl ? { ttl: opts.ttl } : {}),
  });
  return buildNoVncUrl(base, box.vncPassword);
}
