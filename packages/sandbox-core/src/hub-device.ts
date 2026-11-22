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
  keys: readonly ('AGENTBOX_HUB_API_KEY' | 'AGENTBOX_RELAY_ADMIN_TOKEN')[] = [
    'AGENTBOX_HUB_API_KEY',
    'AGENTBOX_RELAY_ADMIN_TOKEN',
  ],
): DeviceCredential | null {
  const cred = readDeviceCredential(home);
  if (!cred || !hubUrl || cred.hubUrl !== normalizeHubUrl(hubUrl)) return null;
  for (const k of keys) if (!env[k]) env[k] = cred.token;
  return cred;
}

export function isDeviceToken(value: string): boolean {
  return value.startsWith('abdev_');
}

/**
 * The Bearer to present to the hub at `url`, resolved per URL so a credential
 * never reaches a hub that did not issue it (a box record can name an older hub
 * than the one configured now).
 *
 * 1. An explicitly exported shared key (`AGENTBOX_HUB_API_KEY` for `api`,
 *    `AGENTBOX_RELAY_ADMIN_TOKEN` for `admin`) — the operator's override, as
 *    everywhere else. A device token in the env, or a value the CLI merely
 *    copied in from `control-plane.env`, does not count as explicit.
 * 2. This PC's device token, when `url` is the hub that issued it.
 * 3. The shared key in `control-plane.env`, only for `configuredUrl` — the hub
 *    `hub setup` wrote it for.
 */
export function hubBearerFor(
  url: string,
  kind: 'api' | 'admin',
  opts: { configuredUrl?: string; env?: NodeJS.ProcessEnv; home?: string } = {},
): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const key = kind === 'api' ? 'AGENTBOX_HUB_API_KEY' : 'AGENTBOX_RELAY_ADMIN_TOKEN';
  const filePath = join(home, '.agentbox', 'control-plane', 'control-plane.env');
  let fileValue = '';
  if (existsSync(filePath)) {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(filePath, 'utf8'));
    fileValue = m?.[1]?.trim() ?? '';
  }
  const fromEnv = (env[key] ?? '').trim();
  if (fromEnv && !isDeviceToken(fromEnv) && fromEnv !== fileValue) return fromEnv;
  const own = deviceTokenFor(url, home);
  if (own) return own;
  const target = normalizeHubUrl(url);
  if (fileValue && opts.configuredUrl && normalizeHubUrl(opts.configuredUrl) === target) {
    return fileValue;
  }
  return '';
}
