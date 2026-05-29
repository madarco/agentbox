import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Vercel env auto-loader. The `@vercel/sandbox` SDK reads `VERCEL_OIDC_TOKEN`
 * from `process.env`; for the access-token path we read `VERCEL_TOKEN` +
 * `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` and thread them into every SDK call as
 * explicit `Credentials`. We pull all of these in from `~/.agentbox/secrets.env`
 * (written by `agentbox vercel login`) so the SDK Just Works after a one-time
 * login — exactly the daytona/hetzner model.
 *
 * Lookup order (first wins; process.env is never overwritten):
 *   1. `process.env` (already set in the shell).
 *   2. `~/.agentbox/secrets.env` — written by `agentbox vercel login`.
 *
 * Project-level `.env` / `.env.local` are intentionally NOT consulted: those
 * files belong to the app code being developed, and a `VERCEL_*` value there
 * (e.g. a `vercel env pull` OIDC token, or the app's own deploy token) is meant
 * for in-box code, not for the host CLI to harvest and provision sandboxes with.
 * Put host credentials in `~/.agentbox/secrets.env` (or the shell env).
 *
 * Only Vercel-prefixed keys are imported; the rest of the file is left alone.
 * Idempotent and side-effect-free after the first call.
 */
const VERCEL_KEYS = [
  'VERCEL_OIDC_TOKEN',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID',
  // Marker for CLI-login mode (`agentbox vercel login` → `sandbox login`). The
  // access token is NOT stored here — it's read live from the Vercel CLI store;
  // only this marker + team/project ids are persisted.
  'VERCEL_AUTH_SOURCE',
] as const;

let loaded = false;

export function ensureVercelEnvLoaded(): void {
  if (loaded) return;
  loaded = true;
  importVercelFromFile(resolve(homedir(), '.agentbox', 'secrets.env'), VERCEL_KEYS);
}

/**
 * Force a re-read of `~/.agentbox/secrets.env`. Used by the interactive
 * `agentbox vercel login` flow after it persists the credential trio, so the
 * same process can pick it up without a restart.
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
