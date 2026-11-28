/**
 * The hub owner's two shared keys, the API key and the admin token, as the
 * machine that ran `agentbox hub setup` holds them in `control-plane.env`.
 *
 * Read from the file (an exported shared key wins), never from what
 * `loadControlPlaneEnv` left in `process.env`: once this machine is enrolled as
 * a device, that put its device token into both keys, and the hub's owner-only
 * device routes refuse a device token.
 */
import { isDeviceToken } from '@agentbox/sandbox-core';
import { CONTROL_PLANE_ENV_PATH, readControlPlaneEnvMap } from './env-file.js';

export interface OwnerCredentials {
  /** `AGENTBOX_HUB_API_KEY`, the `/api/v1` Bearer. */
  apiKey: string;
  /** `AGENTBOX_RELAY_ADMIN_TOKEN`, sent as `X-Agentbox-Admin-Token`. */
  adminToken: string;
}

/** Both keys, or null when this machine does not hold both. */
export function readOwnerCredentials(
  env: NodeJS.ProcessEnv = process.env,
  path: string = CONTROL_PLANE_ENV_PATH,
): OwnerCredentials | null {
  const file = readControlPlaneEnvMap(path);
  const pick = (key: 'AGENTBOX_HUB_API_KEY' | 'AGENTBOX_RELAY_ADMIN_TOKEN'): string => {
    const exported = (env[key] ?? '').trim();
    if (exported && !isDeviceToken(exported)) return exported;
    const stored = (file[key] ?? '').trim();
    return isDeviceToken(stored) ? '' : stored;
  };
  const apiKey = pick('AGENTBOX_HUB_API_KEY');
  const adminToken = pick('AGENTBOX_RELAY_ADMIN_TOKEN');
  return apiKey && adminToken ? { apiKey, adminToken } : null;
}
