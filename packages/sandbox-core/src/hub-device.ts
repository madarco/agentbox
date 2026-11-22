/**
 * This PC's enrollment on a remote hub (`agentbox hub login`, multi-PC Phase 1b):
 * one 0600 file, `~/.agentbox/control-plane/device.json`, holding the per-device
 * token the hub minted when its owner approved this machine.
 *
 * A PC that logged in holds no shared secret. Wherever the CLI or the relay used
 * to read `AGENTBOX_HUB_API_KEY` / `AGENTBOX_RELAY_ADMIN_TOKEN` from
 * `control-plane.env`, the device token stands in for both when it was issued by
 * the hub this machine is configured to use (see {@link applyDeviceCredentialEnv}).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface DeviceCredential {
  /** The hub that issued the token, normalized (no trailing slash). */
  hubUrl: string;
  /** This PC's machine id, as the hub recorded it. */
  deviceId: string;
  label: string;
  token: string;
  /** ISO time of the approval. */
  enrolledAt: string;
}

export function deviceCredentialPath(home: string = homedir()): string {
  return join(home, '.agentbox', 'control-plane', 'device.json');
}

export function normalizeHubUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function readDeviceCredential(home: string = homedir()): DeviceCredential | null {
  const path = deviceCredentialPath(home);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeviceCredential>;
    if (
      typeof raw.hubUrl !== 'string' ||
      typeof raw.token !== 'string' ||
      typeof raw.deviceId !== 'string' ||
      raw.token.length === 0
    ) {
      return null;
    }
    return {
      hubUrl: normalizeHubUrl(raw.hubUrl),
      deviceId: raw.deviceId,
      label: typeof raw.label === 'string' ? raw.label : '',
      token: raw.token,
      enrolledAt: typeof raw.enrolledAt === 'string' ? raw.enrolledAt : '',
    };
  } catch {
    return null;
  }
}

export function writeDeviceCredential(cred: DeviceCredential, home: string = homedir()): string {
  const path = deviceCredentialPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    `${JSON.stringify({ ...cred, hubUrl: normalizeHubUrl(cred.hubUrl) }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  return path;
}

/** Returns whether there was a file to remove. */
export function removeDeviceCredential(home: string = homedir()): boolean {
  const path = deviceCredentialPath(home);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * The device token for `hubUrl`, or '' when this PC is not enrolled there. A
 * token is never presented to a hub other than the one that issued it.
 */
export function deviceTokenFor(hubUrl: string, home: string = homedir()): string {
  const cred = readDeviceCredential(home);
  if (!cred || !hubUrl) return '';
  return cred.hubUrl === normalizeHubUrl(hubUrl) ? cred.token : '';
}

/**
 * Put the device token into `env` as the hub credential, for the hub at
 * `hubUrl` only (no URL, no token).
 *
 * It fills `AGENTBOX_HUB_API_KEY` (the `/api/v1` Bearer) and
 * `AGENTBOX_RELAY_ADMIN_TOKEN` (the `/admin/*` Bearer the host-reach poller,
 * custody reads and the create path send) — the hub accepts a device token on
 * both surfaces — so every existing reader of those keys works unchanged. An
 * explicitly exported value is never overwritten. Call it BEFORE merging
 * `control-plane.env`, so an enrolled PC presents its own token rather than a
 * shared secret that happens to be on disk.
 *
 * Returns the credential it applied, or null.
 */
export function applyDeviceCredentialEnv(
  env: NodeJS.ProcessEnv,
  hubUrl: string,
  home: string = homedir(),
): DeviceCredential | null {
  const cred = readDeviceCredential(home);
  if (!cred || !hubUrl || cred.hubUrl !== normalizeHubUrl(hubUrl)) return null;
  if (!env.AGENTBOX_HUB_API_KEY) env.AGENTBOX_HUB_API_KEY = cred.token;
  if (!env.AGENTBOX_RELAY_ADMIN_TOKEN) env.AGENTBOX_RELAY_ADMIN_TOKEN = cred.token;
  return cred;
}
