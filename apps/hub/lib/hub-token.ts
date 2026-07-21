import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AUTH_TOKEN_PATH } from './auth-config';

/**
 * Read the localhost token gate secret, generating + persisting one (0600) on
 * first run. Node-only (no `server-only`) — imported by server.ts under tsx. The
 * middleware never reads the file; server.ts hands the value to it via
 * `process.env.AGENTBOX_HUB_TOKEN`.
 */
export async function ensureHubToken(): Promise<string> {
  try {
    const existing = (await readFile(AUTH_TOKEN_PATH, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    /* not created yet */
  }
  const token = randomBytes(32).toString('hex');
  await mkdir(dirname(AUTH_TOKEN_PATH), { recursive: true });
  await writeFile(AUTH_TOKEN_PATH, token + '\n', { mode: 0o600 });
  return token;
}
