/**
 * Interactive Tenki credential setup. Single mode — paste a workspace auth
 * token (`tk_…`) from the Tenki dashboard. Persists to
 * `~/.agentbox/secrets.env` (the canonical store, matching daytona / hetzner /
 * vercel / e2b).
 *
 * Non-interactive callers (no TTY): silent no-op, so scripted/CI runs surface
 * the SDK's own "not configured" error instead of hanging on a prompt.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { hostOpenCommand } from '@agentbox/sandbox-core';
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  password,
} from '@clack/prompts';
import { ensureTenkiEnvLoaded, reloadTenkiEnv } from './env-loader.js';
import { hasUsableCredentials } from './sdk.js';

// Ctrl+C at a prompt resolves with the cancel symbol; turn that into a real
// quit so the command never silently continues as if the user answered "No".
function exitOnCancel<T>(v: T | symbol): T {
  if (isCancel(v)) {
    cancel('Cancelled.');
    process.exit(130);
  }
  return v as T;
}

const DASHBOARD_URL = 'https://tenki.cloud';
const DOCS_URL = 'https://tenki.cloud/docs';

/**
 * Keys we manage in `~/.agentbox/secrets.env`. On reconfigure we strip prior
 * values for these before appending so the file never accumulates duplicates.
 */
const MANAGED_KEYS = ['TENKI_AUTH_TOKEN'] as const;

export interface EnsureTenkiCredentialsOptions {
  /** Re-prompt even when valid credentials are already present (`agentbox tenki login`). */
  force?: boolean;
}

export async function ensureTenkiCredentials(
  opts: EnsureTenkiCredentialsOptions = {},
): Promise<void> {
  ensureTenkiEnvLoaded();

  if (!opts.force && hasUsableCredentials()) return;
  if (!process.stdin.isTTY) return;

  intro('Tenki setup');
  note(
    `AgentBox needs a Tenki workspace auth token to provision sandboxes.\n` +
      `Create one in your Tenki dashboard (${DASHBOARD_URL}; see ${DOCS_URL}), then paste it below.\n` +
      `The token is stored in \`~/.agentbox/secrets.env\` (mode 0600) — no .env.local harvesting.`,
    'Credentials required',
  );

  const openIt = exitOnCancel(
    await confirm({
      message: `Open ${DASHBOARD_URL} to create a token?`,
      initialValue: true,
    }),
  );
  if (openIt) openDashboard();

  const token = exitOnCancel(
    await password({
      message: 'Paste your Tenki auth token (tk_…)',
      validate: (v) => (v && v.trim().length > 0 ? undefined : 'Cannot be empty'),
    }),
  );

  persistCredentials({ authToken: token.trim() });
  reloadTenkiEnv();
  log.success(`Tenki credentials saved to ${secretsPath()}`);
  outro('Setup complete.');
}

function persistCredentials(creds: { authToken: string }): void {
  writeManaged({ TENKI_AUTH_TOKEN: creds.authToken });
}

/**
 * Atomically rewrite the managed Tenki keys in `~/.agentbox/secrets.env`:
 * strip every prior value for a `MANAGED_KEYS` entry, then append exactly the
 * keys in `record` (mode 0600, temp-file + rename). Also mirrors the record
 * into `process.env` so the current run uses the new values immediately.
 */
function writeManaged(record: Record<string, string>): void {
  for (const k of MANAGED_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(record)) process.env[k] = v;

  const path = secretsPath();
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
      return !(MANAGED_KEYS as readonly string[]).includes(key);
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
    // ignore — already attempted above
  }
}

function openDashboard(): void {
  import('node:child_process')
    .then(({ spawnSync }) => {
      const r = spawnSync(hostOpenCommand(), [DASHBOARD_URL], { stdio: 'ignore' });
      if (r.status !== 0) {
        log.warn(`Could not auto-open the browser — visit ${DASHBOARD_URL} manually.`);
      }
    })
    .catch(() => {
      log.warn(`Could not auto-open the browser — visit ${DASHBOARD_URL} manually.`);
    });
}

export function secretsPath(): string {
  return resolve(homedir(), '.agentbox', 'secrets.env');
}

export interface TenkiCredStatus {
  auth: 'token' | 'none';
  token?: string;
  source: 'env' | 'secrets.env' | 'none';
}

export function readTenkiCredStatus(): TenkiCredStatus {
  const shellHad = process.env.TENKI_AUTH_TOKEN !== undefined;
  ensureTenkiEnvLoaded();
  const token = process.env.TENKI_AUTH_TOKEN;
  if (!token) return { auth: 'none', source: 'none' };
  return { auth: 'token', token, source: shellHad ? 'env' : 'secrets.env' };
}

export function maskKey(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${'*'.repeat(8)}${value.slice(-4)}`;
}
