/**
 * Codex's host-side credential check. See `agents/claude/host-creds.ts` for why
 * these live beside their runtimes rather than in the shared queue helper.
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SHARED_CODEX_VOLUME, volumeHasCodexAuth } from '../docker-sync.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when Codex is already authenticated: `OPENAI_API_KEY` in env, a host
 * `~/.codex/auth.json`, or an `auth.json` already in the shared codex-config
 * volume. Mirrors the foreground command's local helper so the `-i`
 * pre-flight and the interactive login offer agree on what counts as
 * "seeded".
 */
export async function codexAuthAvailable(
  image: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if ((env['OPENAI_API_KEY'] ?? '').length > 0) return true;
  if (await fileExists(join(homedir(), '.codex', 'auth.json'))) return true;
  return volumeHasCodexAuth(SHARED_CODEX_VOLUME, image);
}
