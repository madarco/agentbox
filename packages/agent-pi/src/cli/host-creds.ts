/**
 * Pi's host-side credential check. Lives beside its runtime rather than in a
 * shared helper for the same reason the other agents' do — the shared one used
 * to dispatch by name and hand an unwired agent someone else's answer.
 */
import { piAuthFileHasProviders } from '../auth-shape.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PI_FORWARDED_ENV_KEYS, SHARED_PI_VOLUME, volumeHasPiAuth } from '../docker-sync.js';

/**
 * True when Pi is already authenticated: any forwarded provider key in the
 * environment, a non-empty host `~/.pi/agent/auth.json`, or an `auth.json`
 * already in the shared volume.
 *
 * Shape, not mere existence — see {@link piAuthFileHasProviders}.
 */
export async function piAuthAvailable(
  image: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  for (const k of PI_FORWARDED_ENV_KEYS) {
    if ((env[k] ?? '').length > 0) return true;
  }
  if (await piAuthFileHasProviders(join(homedir(), '.pi', 'agent', 'auth.json'))) return true;
  return volumeHasPiAuth(SHARED_PI_VOLUME, image);
}
