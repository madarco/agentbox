/**
 * Interactive E2B credential setup. Single mode — paste an API key from
 * https://e2b.dev/dashboard?tab=keys — much simpler than vercel's three-mode
 * flow. Persists to `~/.agentbox/secrets.env` (the canonical store, matching
 * daytona / hetzner / vercel).
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
import { ensureE2bEnvLoaded, reloadE2bEnv } from './env-loader.js';
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

const DASHBOARD_KEYS_URL = 'https://e2b.dev/dashboard?tab=keys';

/**
 * Keys we manage in `~/.agentbox/secrets.env`. On reconfigure we strip prior
 * values for these before appending so the file never accumulates duplicates.
 */
const MANAGED_KEYS = ['E2B_API_KEY'] as const;

export interface EnsureE2bCredentialsOptions {
  /** Re-prompt even when valid credentials are already present (`agentbox e2b login`). */
  force?: boolean;
}

export async function ensureE2bCredentials(
  opts: EnsureE2bCredentialsOptions = {},
): Promise<void> {
  ensureE2bEnvLoaded();

  if (!opts.force && hasUsableCredentials()) return;
  if (!process.stdin.isTTY) return;

  intro('E2B setup');
  note(
    `AgentBox needs an E2B API key to provision sandboxes.\n` +
      `Get one from ${DASHBOARD_KEYS_URL} (free tier available), then paste it below.\n` +
      `The key is stored in \`~/.agentbox/secrets.env\` (mode 0600) — no .env.local harvesting.`,
    'Credentials required',
  );

  const openIt = exitOnCancel(
    await confirm({
      message: `Open ${DASHBOARD_KEYS_URL} to create a key?`,
      initialValue: true,
    }),
  );
  if (openIt) openDashboard();

  const key = exitOnCancel(
    await password({
      message: 'Paste your E2B API key',
      validate: (v) => (v && v.trim().length > 0 ? undefined : 'Cannot be empty'),
    }),
  );

  persistCredentials({ apiKey: key.trim() });
  reloadE2bEnv();
  log.success(`E2B credentials saved to ${secretsPath()}`);
  outro('Setup complete.');
}

function persistCredentials(creds: { apiKey: string }): void {
  writeManaged({ E2B_API_KEY: creds.apiKey });
}

/**
 * Atomically rewrite the managed E2B keys in `~/.agentbox/secrets.env`:
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
      const r = spawnSync(hostOpenCommand(), [DASHBOARD_KEYS_URL], { stdio: 'ignore' });
      if (r.status !== 0) {
        log.warn(`Could not auto-open the browser — visit ${DASHBOARD_KEYS_URL} manually.`);
      }
    })
    .catch(() => {
      log.warn(`Could not auto-open the browser — visit ${DASHBOARD_KEYS_URL} manually.`);
    });
}

export function secretsPath(): string {
  return resolve(homedir(), '.agentbox', 'secrets.env');
}

export interface E2bCredStatus {
  auth: 'key' | 'none';
  token?: string;
  source: 'env' | 'secrets.env' | 'none';
}

export function readE2bCredStatus(): E2bCredStatus {
  const shellHad = process.env.E2B_API_KEY !== undefined;
  ensureE2bEnvLoaded();
  const key = process.env.E2B_API_KEY;
  if (!key) return { auth: 'none', source: 'none' };
  return { auth: 'key', token: key, source: shellHad ? 'env' : 'secrets.env' };
}

export function maskKey(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${'*'.repeat(8)}${value.slice(-4)}`;
}
