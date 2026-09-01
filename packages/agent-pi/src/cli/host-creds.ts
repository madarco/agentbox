/**
 * Pi's host-side credential check. Lives beside its runtime rather than in a
 * shared helper for the same reason the other agents' do — the shared one used
 * to dispatch by name and hand an unwired agent someone else's answer.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PI_FORWARDED_ENV_KEYS, SHARED_PI_VOLUME, volumeHasPiAuth } from '../docker-sync.js';

/**
 * A usable `auth.json`: parses, and holds at least one provider.
 *
 * Not an existence or size check. Pi writes a literal `{}` on first run, before
 * any provider is added — measured on a real host — so both would report every
 * machine that has ever launched Pi as signed in, and the sign-in offer would
 * never appear. This mirrors the registry's `realShape: 'nonempty-json'`.
 */
async function hasProviders(p: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(p, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

/**
 * True when Pi is already authenticated: any forwarded provider key in the
 * environment, a non-empty host `~/.pi/agent/auth.json`, or an `auth.json`
 * already in the shared volume.
 *
 * Shape, not mere existence — see {@link hasProviders}.
 */
export async function piAuthAvailable(
  image: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  for (const k of PI_FORWARDED_ENV_KEYS) {
    if ((env[k] ?? '').length > 0) return true;
  }
  if (await hasProviders(join(homedir(), '.pi', 'agent', 'auth.json'))) return true;
  return volumeHasPiAuth(SHARED_PI_VOLUME, image);
}
