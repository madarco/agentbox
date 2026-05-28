import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Vercel env auto-loader. The `@vercel/sandbox` SDK reads `VERCEL_OIDC_TOKEN`
 * from `process.env` automatically; for the access-token fallback we read
 * `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` and thread them into
 * every SDK call as explicit `Credentials`. We pull all of these in from
 * `~/.agentbox/secrets.env` (written by `agentbox vercel login`) and, for the
 * OIDC token specifically, from a project-local `.env.local` (the file
 * `vercel env pull` writes) so the SDK Just Works after a `vercel link`.
 *
 * Lookup order (first wins; process.env is never overwritten):
 *   1. `process.env` (already set in the shell).
 *   2. `~/.agentbox/secrets.env` — written by `agentbox vercel login`.
 *   3. `<cwd>/.env.local` — for `VERCEL_OIDC_TOKEN` only (the `vercel env pull`
 *      target). The dev OIDC token expires after 12h; re-pull when it does.
 *
 * Only Vercel-prefixed keys are imported; the rest of the file is left alone.
 * Idempotent and side-effect-free after the first call.
 */
const VERCEL_KEYS = [
  'VERCEL_OIDC_TOKEN',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID',
] as const;

let loaded = false;

export function ensureVercelEnvLoaded(): void {
  if (loaded) return;
  loaded = true;
  importVercelFromFile(resolve(homedir(), '.agentbox', 'secrets.env'), VERCEL_KEYS);
  // `.env.local` is the `vercel env pull` target — only harvest the OIDC token
  // from it, never the rest of the app's env.
  importVercelFromFile(resolve(process.cwd(), '.env.local'), ['VERCEL_OIDC_TOKEN']);
}

/**
 * Force a re-read of the secrets/`.env.local` files. Used by the interactive
 * `agentbox vercel login` flow after it tells the user to run `vercel env pull`
 * in another shell — the file may now carry a `VERCEL_OIDC_TOKEN` the first
 * (cached) load didn't see.
 */
export function reloadVercelEnv(): void {
  loaded = false;
  ensureVercelEnvLoaded();
}

function importVercelFromFile(path: string, keys: readonly string[]): void {
  if (!existsSync(path)) return;
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const parsed = parseEnvFile(body);
  for (const key of keys) {
    if (process.env[key] !== undefined) continue;
    const value = parsed[key];
    if (typeof value === 'string') {
      process.env[key] = value;
    }
  }
}

/**
 * Minimal `.env` parser: handles `KEY=value`, `KEY="value"`, `KEY='value'`,
 * `export KEY=value`, blank lines, and `#` comments. No variable
 * interpolation — predictable over feature-complete (matches the daytona
 * loader's behavior).
 */
export function parseEnvFile(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
