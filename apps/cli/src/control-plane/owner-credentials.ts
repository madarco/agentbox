/**
 * The hub owner's two shared keys, the API key and the admin token, as the
 * machine that ran `agentbox hub setup` holds them in `control-plane.env`.
 *
 * Read from the file (or an exported pair), never from what
 * `loadControlPlaneEnv` left in `process.env`: once this machine is enrolled as
 * a device, that put its device token into both keys, and the hub's owner-only
 * device routes refuse a device token.
 */
import { existsSync, readFileSync } from 'node:fs';
import { controlPlaneDeployPath, isDeviceToken, normalizeHubUrl } from '@agentbox/sandbox-core';
import { CONTROL_PLANE_ENV_PATH, readControlPlaneEnvMap } from './env-file.js';

export interface OwnerCredentials {
  /** `AGENTBOX_HUB_API_KEY`, the `/api/v1` Bearer. */
  apiKey: string;
  /** `AGENTBOX_RELAY_ADMIN_TOKEN`, sent as `X-Agentbox-Admin-Token`. */
  adminToken: string;
}

const API = 'AGENTBOX_HUB_API_KEY';
const ADMIN = 'AGENTBOX_RELAY_ADMIN_TOKEN';

/**
 * Both keys from one source, or null when this machine does not hold both. An
 * exported pair wins over the file; one exported key is never mixed with the
 * other from the file, since they could belong to different hubs.
 */
export function readOwnerCredentials(
  env: NodeJS.ProcessEnv = process.env,
  path: string = CONTROL_PLANE_ENV_PATH,
): OwnerCredentials | null {
  const pair = (apiKey: string | undefined, adminToken: string | undefined) => {
    const a = (apiKey ?? '').trim();
    const t = (adminToken ?? '').trim();
    return a && t && !isDeviceToken(a) && !isDeviceToken(t) ? { apiKey: a, adminToken: t } : null;
  };
  const file = readControlPlaneEnvMap(path);
  return pair(env[API], env[ADMIN]) ?? pair(file[API], file[ADMIN]);
}

/**
 * The owner keys, only for the hub they were written for: a hub on this
 * machine (`hub expose`), or the one the deploy record names. With no deploy
 * record they are taken to be the configured hub's, as `hubBearerFor` does.
 */
export function ownerCredentialsFor(
  hubUrl: string,
  opts: { onThisMachine: boolean; deployPath?: string; env?: NodeJS.ProcessEnv; envPath?: string },
): OwnerCredentials | null {
  const owner = readOwnerCredentials(opts.env, opts.envPath);
  if (!owner || opts.onThisMachine) return owner;
  const deployPath = opts.deployPath ?? controlPlaneDeployPath();
  if (!existsSync(deployPath)) return owner;
  try {
    const record = JSON.parse(readFileSync(deployPath, 'utf8')) as { url?: unknown };
    if (typeof record.url !== 'string') return owner;
    return normalizeHubUrl(record.url) === normalizeHubUrl(hubUrl) ? owner : null;
  } catch {
    return null;
  }
}
