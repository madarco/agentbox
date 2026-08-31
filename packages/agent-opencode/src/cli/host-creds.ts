/**
 * OpenCode's host-side credential check. See `agents/claude/host-creds.ts` for
 * why these live beside their runtimes rather than in the shared queue helper.
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  OPENCODE_FORWARDED_ENV_KEYS,
  SHARED_OPENCODE_VOLUME,
  volumeHasOpencodeAuth,
} from '../docker-sync.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when OpenCode is already authenticated: any of its forwarded provider
 * env keys, a host `~/.local/share/opencode/auth.json`, or an `auth.json`
 * already in the shared opencode volume.
 */
export async function opencodeAuthAvailable(
  image: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  for (const k of OPENCODE_FORWARDED_ENV_KEYS) {
    if ((env[k] ?? '').length > 0) return true;
  }
  if (await fileExists(join(homedir(), '.local', 'share', 'opencode', 'auth.json'))) return true;
  return volumeHasOpencodeAuth(SHARED_OPENCODE_VOLUME, image);
}
