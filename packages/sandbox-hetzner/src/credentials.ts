import { spawnSync } from 'node:child_process';
import { hostOpenCommand, writeManagedSecrets, type CredSetResult } from '@agentbox/sandbox-core';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  cancel,
  confirm,
  isCancel,
  intro,
  log,
  note,
  outro,
  password,
  spinner,
} from '@clack/prompts';
import { makeHetznerClient } from './client.js';
import { ensureHetznerEnvLoaded } from './env-loader.js';

// Ctrl+C at a prompt resolves with the cancel symbol; turn that into a real
// quit so the command never silently continues as if the user answered "No".
function exitOnCancel<T>(v: T | symbol): T {
  if (isCancel(v)) {
    cancel('Cancelled.');
    process.exit(130);
  }
  return v as T;
}

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

  const open = exitOnCancel(
    await confirm({
      message: `Open ${DASHBOARD_KEYS_URL} in your browser?`,
      initialValue: true,
    }),
  );
  if (open) openDashboard();

  // One retry on auth failure (typos / expired token are the common case).
  for (let attempt = 0; attempt < 2; attempt++) {
    const creds = await promptForCredentials();

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

async function promptForCredentials(): Promise<Credentials> {
  const token = exitOnCancel(
    await password({
      message: 'Paste your Hetzner Cloud API token',
      validate(v) {
        if (!v || v.trim().length === 0) return 'Cannot be empty';
        return undefined;
      },
    }),
  );
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
  const record: Record<string, string> = { HCLOUD_TOKEN: creds.token };
  if (creds.endpoint) record.HCLOUD_ENDPOINT = creds.endpoint;
  writeManagedSecrets(MANAGED_KEYS, record);
}

/**
 * Non-interactive credential set (the headless path the hub drives). Validates
 * `{ token, endpoint? }` against the Hetzner API (a cheap `listLocations`), then
 * persists to `~/.agentbox/secrets.env`. A network failure still persists (so an
 * offline host isn't blocked) but reports `ok:true` with a warning label.
 */
export async function setHetznerCredentials(
  fields: Record<string, string>,
): Promise<CredSetResult> {
  const token = (fields.token ?? '').trim();
  const endpoint = (fields.endpoint ?? '').trim() || undefined;
  if (!token) {
    return { ok: false, error: 'token is required', status: { configured: false } };
  }
  const creds: Credentials = { token, endpoint };
  const result = await validateCredentials(creds);
  if (!result.ok && result.kind === 'auth') {
    return { ok: false, error: `token rejected by Hetzner: ${result.message}`, status: { configured: false } };
  }
  persistCredentials(creds);
  const label = result.ok ? 'token' : 'token (unvalidated)';
  return { ok: true, status: { configured: true, label } };
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
