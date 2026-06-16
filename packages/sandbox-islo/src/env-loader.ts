/**
 * Islo env auto-loader. Host credentials live in `~/.agentbox/secrets.env`
 * or the shell env, never in project `.env` files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const ISLO_KEYS = ['ISLO_API_KEY', 'ISLO_BASE_URL', 'AGENTBOX_ISLO_API_KEY', 'AGENTBOX_ISLO_BASE_URL'] as const;

let loaded = false;

export function ensureIsloEnvLoaded(): void {
  if (loaded) return;
  loaded = true;
  importIsloFromFile(resolve(homedir(), '.agentbox', 'secrets.env'), ISLO_KEYS);
}

export function reloadIsloEnv(): void {
  loaded = false;
  ensureIsloEnvLoaded();
}

function importIsloFromFile(path: string, keys: readonly string[]): void {
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
    if (typeof value === 'string') process.env[key] = value;
  }
}

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
