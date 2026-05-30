import { spawnSync } from 'node:child_process';
import { hostOpenCommand } from '@agentbox/sandbox-core';
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
import { confirm, isCancel, intro, log, note, outro, password, spinner } from '@clack/prompts';
import { makeHetznerClient } from './client.js';
import { ensureHetznerEnvLoaded } from './env-loader.js';

const DASHBOARD_KEYS_URL = 'https://console.hetzner.cloud/projects';

/**
 * Keys we manage in `~/.agentbox/secrets.env`. When the user reconfigures
 * we strip prior values before appending so the file never accumulates
 * duplicates. `HCLOUD_ENDPOINT` is honored but we don't prompt for it
 * (default endpoint covers 100% of users).
 */
const MANAGED_KEYS = ['HCLOUD_TOKEN', 'HCLOUD_ENDPOINT'] as const;
type ManagedKey = (typeof MANAGED_KEYS)[number];

export interface EnsureHetznerCredentialsOptions {
  /** Re-prompt even when valid credentials are already present (used by `agentbox hetzner login`). */
  force?: boolean;
}

/**
 * First-run interactive setup for Hetzner credentials. Walks the user
 * through creating a project API token, pasting it, validating, and
 * persisting to `~/.agentbox/secrets.env`.
 *
 * No-op when credentials are already configured (env var or our secrets
 * file). Silent no-op when stdin isn't a TTY so scripted/CI callers get
 * the API "401 unauthorized" error instead of a hung prompt.
 *
 * Mirrors `ensureDaytonaCredentials()` in shape so the registry's first-
 * run gate stays uniform across providers.
 */
export async function ensureHetznerCredentials(
  opts: EnsureHetznerCredentialsOptions = {},
): Promise<void> {
  ensureHetznerEnvLoaded();

  if (!opts.force && hasUsableCredentials()) return;
  if (!process.stdin.isTTY) return;

  intro('Hetzner Cloud setup');
  note(
    `AgentBox needs a Hetzner Cloud API token (project-scoped) to provision VPSes.\n\n` +
      `1. Open ${DASHBOARD_KEYS_URL}\n` +
      `2. Pick a project (or create one).\n` +
      `3. Security → API Tokens → Generate API Token (Read + Write).`,
    'API token required',
  );

  const open = await confirm({
    message: `Open ${DASHBOARD_KEYS_URL} in your browser?`,
    initialValue: true,
  });
  if (isCancel(open)) {
    log.warn('Hetzner setup cancelled — re-run `agentbox hetzner login` when ready.');
    return;
  }
  if (open) openDashboard();

  // One retry on auth failure (typos / expired token are the common case).
  for (let attempt = 0; attempt < 2; attempt++) {
    const creds = await promptForCredentials();
    if (creds === null) return;

    const result = await validateCredentials(creds);
    if (result.ok) {
      persistCredentials(creds);
      log.success(`Hetzner credentials saved to ${secretsPath()}`);
      outro('Setup complete.');
      return;
    }
    if (result.kind === 'auth' && attempt === 0) {
      log.error(`That token was rejected by Hetzner: ${result.message}`);
      log.info('Try again, or press Ctrl-C to cancel.');
      continue;
    }
    if (result.kind === 'network') {
      log.warn(`Could not reach Hetzner to validate (${result.message}) — saving anyway.`);
      persistCredentials(creds);
      log.success(`Hetzner credentials saved to ${secretsPath()}`);
      outro('Setup complete (unvalidated).');
      return;
    }
    throw new Error(`Hetzner credentials rejected: ${result.message}`);
  }
}

function hasUsableCredentials(): boolean {
  return typeof process.env.HCLOUD_TOKEN === 'string' && process.env.HCLOUD_TOKEN.length > 0;
}

interface Credentials {
  token: string;
  endpoint?: string;
}

async function promptForCredentials(): Promise<Credentials | null> {
  const token = await password({
    message: 'Paste your Hetzner Cloud API token',
    validate(v) {
      if (!v || v.trim().length === 0) return 'Cannot be empty';
      return undefined;
    },
  });
  if (isCancel(token)) {
    log.warn('Hetzner setup cancelled.');
    return null;
  }
  return { token: token.trim() };
}

type ValidationResult =
  | { ok: true }
  | { ok: false; kind: 'auth'; message: string }
  | { ok: false; kind: 'network'; message: string };

async function validateCredentials(creds: Credentials): Promise<ValidationResult> {
  const s = spinner();
  s.start('Validating credentials with Hetzner');

  try {
    const client = makeHetznerClient({ token: creds.token, endpoint: creds.endpoint });
    // `listLocations()` is a cheap, deterministic call that exercises auth +
    // basic API reachability without provisioning anything.
    await client.listLocations();
    s.stop('Hetzner credentials accepted');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop('Hetzner credentials check failed');
    if (/401|403|unauthor|forbidden|invalid|token/i.test(message)) {
      return { ok: false, kind: 'auth', message };
    }
    return { ok: false, kind: 'network', message };
  }
}

function persistCredentials(creds: Credentials): void {
  process.env.HCLOUD_TOKEN = creds.token;
  if (creds.endpoint) process.env.HCLOUD_ENDPOINT = creds.endpoint;
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

  const lines: string[] = [`HCLOUD_TOKEN=${creds.token}`];
  if (creds.endpoint) lines.push(`HCLOUD_ENDPOINT=${creds.endpoint}`);

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
    // ignore — already attempted above.
  }
}

function openDashboard(): void {
  try {
    const r = spawnSync(hostOpenCommand(), [DASHBOARD_KEYS_URL], { stdio: 'ignore' });
    if (r.status !== 0) {
      log.warn(`Could not auto-open the browser — visit ${DASHBOARD_KEYS_URL} manually.`);
    }
  } catch {
    log.warn(`Could not auto-open the browser — visit ${DASHBOARD_KEYS_URL} manually.`);
  }
}

export function secretsPath(): string {
  return resolve(homedir(), '.agentbox', 'secrets.env');
}

export interface HetznerCredStatus {
  token?: string;
  endpoint?: string;
  source: 'env' | 'secrets.env' | 'none';
}

export function readHetznerCredStatus(): HetznerCredStatus {
  const shellHadToken = !!process.env.HCLOUD_TOKEN;
  ensureHetznerEnvLoaded();
  const token = process.env.HCLOUD_TOKEN;
  const endpoint = process.env.HCLOUD_ENDPOINT;
  if (!token) return { source: 'none' };
  return {
    token,
    endpoint,
    source: shellHadToken ? 'env' : 'secrets.env',
  };
}

export function maskKey(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${'*'.repeat(8)}${value.slice(-4)}`;
}

/** Snapshot of the managed env keys (used by tests around `applyToEnv`). */
export function snapshotManagedEnv(): Record<ManagedKey, string | undefined> {
  const out = {} as Record<ManagedKey, string | undefined>;
  for (const k of MANAGED_KEYS) out[k] = process.env[k];
  return out;
}

export function restoreManagedEnv(snap: Record<ManagedKey, string | undefined>): void {
  for (const k of MANAGED_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}
