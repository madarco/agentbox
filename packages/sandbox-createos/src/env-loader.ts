import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

let loaded = false;

export function ensureCreateOsEnvLoaded(): void {
  if (loaded) return;
  loaded = true;
  loadSecretsEnv();
}

export function reloadCreateOsEnv(): void {
  loaded = false;
  ensureCreateOsEnvLoaded();
}

function loadSecretsEnv(): void {
  const file = resolve(homedir(), '.agentbox', 'secrets.env');
  if (!existsSync(file)) return;
  const body = readFileSync(file, 'utf8');
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(line.slice(eq + 1).trim());
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
