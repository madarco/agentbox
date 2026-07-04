/**
 * Shared writer for the managed cloud-credential store at
 * `~/.agentbox/secrets.env`. Every cloud provider (`daytona`, `hetzner`,
 * `vercel`, `e2b`) persists its API keys/tokens here so the per-provider
 * env-loaders pick them up for every command. The write logic was copy-pasted
 * across four `credentials.ts` files (`writeManaged` / `persistCredentials`);
 * this consolidates it.
 *
 * The file is a plain `KEY=value` env file (optionally `export KEY=value`),
 * mode 0600, written atomically (temp + rename, atomic on the same filesystem).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

/** Canonical path of the managed secrets file: `~/.agentbox/secrets.env`. */
export function secretsEnvPath(): string {
  return resolve(homedir(), '.agentbox', 'secrets.env');
}

/**
 * Atomically rewrite a set of managed keys in `~/.agentbox/secrets.env`: strip
 * every prior value for a `managedKeys` entry (whether written as `KEY=` or
 * `export KEY=`), then append exactly the keys in `record`. Unrelated lines the
 * user dropped in the file are preserved untouched. Also mirrors the change into
 * `process.env` — every `managedKeys` entry is cleared first, then `record` is
 * applied — so the current process uses the new values immediately (and a stale
 * alternate auth method, e.g. an old JWT when switching to an API key, is gone).
 *
 * File is written mode 0600.
 */
export function writeManagedSecrets(
  managedKeys: readonly string[],
  record: Record<string, string>,
): void {
  for (const k of managedKeys) delete process.env[k];
  for (const [k, v] of Object.entries(record)) process.env[k] = v;

  const path = secretsEnvPath();
  mkdirSync(dirname(path), { recursive: true });

  let existing = '';
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      existing = '';
    }
  }

  const kept = existing
    .split(/\r?\n/)
    .filter((line) => {
      const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
      const eq = stripped.indexOf('=');
      if (eq <= 0) return true;
      const key = stripped.slice(0, eq).trim();
      return !managedKeys.includes(key);
    })
    .join('\n')
    .replace(/\s+$/u, '');

  const lines = Object.entries(record).map(([k, v]) => `${k}=${v}`);
  const body = (kept ? `${kept}\n` : '') + lines.join('\n') + '\n';

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // chmod best-effort; writeFileSync mode already covers most filesystems.
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore — already attempted on the temp file
  }
}

/**
 * Mask a secret for display: keep the first and last 4 chars, hide the middle.
 * Short values are fully masked. Never returns the raw secret.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${'*'.repeat(8)}${value.slice(-4)}`;
}
