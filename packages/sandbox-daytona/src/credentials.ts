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
import { confirm, isCancel, intro, log, note, outro, password, spinner, text } from '@clack/prompts';
import { ensureDaytonaEnvLoaded } from './env-loader.js';

const DASHBOARD_KEYS_URL = 'https://app.daytona.io/dashboard/keys';

/**
 * Keys we manage in `~/.agentbox/secrets.env`. When the user reconfigures we
 * strip any prior values for these keys before appending the new ones so the
 * file never accumulates duplicates.
 */
const MANAGED_KEYS = ['DAYTONA_API_KEY', 'DAYTONA_JWT_TOKEN', 'DAYTONA_ORGANIZATION_ID'] as const;
type ManagedKey = (typeof MANAGED_KEYS)[number];

export interface EnsureDaytonaCredentialsOptions {
  /** Re-prompt even when valid credentials are already present (used by `agentbox daytona login`). */
  force?: boolean;
}

/**
 * First-run interactive setup for Daytona credentials. Walks the user through
 * opening the dashboard, pasting an API key (or JWT + organization ID), and
 * persists the result to `~/.agentbox/secrets.env` — which the env-loader
 * already picks up for every cloud command.
 *
 * No-op when credentials are already configured (env var or our secrets
 * file). Silent no-op when stdin isn't a TTY so scripted/CI callers get the
 * "credentials not configured" error from the SDK instead of a hung prompt.
 */
export async function ensureDaytonaCredentials(
  opts: EnsureDaytonaCredentialsOptions = {},
): Promise<void> {
  ensureDaytonaEnvLoaded();

  if (!opts.force && hasUsableCredentials()) return;
  if (!process.stdin.isTTY) return;

  intro('Daytona setup');
  note(
    `AgentBox needs a Daytona API key to provision cloud boxes.\n` +
      `Generate one at ${DASHBOARD_KEYS_URL}`,
    'API key required',
  );

  const open = await confirm({
    message: `Open ${DASHBOARD_KEYS_URL} in your browser?`,
    initialValue: true,
  });
  if (isCancel(open)) {
    log.warn('Daytona setup cancelled — re-run `agentbox daytona login` when ready.');
    return;
  }
  if (open) openDashboard();

  // One retry on auth failure (typos are the common case). Beyond that we bail
  // and surface the validation error; the user can re-run `agentbox daytona login`.
  for (let attempt = 0; attempt < 2; attempt++) {
    const creds = await promptForCredentials();
    if (creds === null) return;

    const result = await validateCredentials(creds);
    if (result.ok) {
      persistCredentials(creds);
      log.success(`Daytona credentials saved to ${secretsPath()}`);
      outro('Setup complete.');
      return;
    }
    if (result.kind === 'auth' && attempt === 0) {
      log.error(`That key was rejected by Daytona: ${result.message}`);
      log.info('Try again, or press Ctrl-C to cancel.');
      continue;
    }
    if (result.kind === 'network') {
      log.warn(`Could not reach Daytona to validate (${result.message}) — saving anyway.`);
      persistCredentials(creds);
      log.success(`Daytona credentials saved to ${secretsPath()}`);
      outro('Setup complete (unvalidated).');
      return;
    }
    throw new Error(`Daytona credentials rejected: ${result.message}`);
  }
}

function hasUsableCredentials(): boolean {
  if (process.env.DAYTONA_API_KEY) return true;
  if (process.env.DAYTONA_JWT_TOKEN && process.env.DAYTONA_ORGANIZATION_ID) return true;
  return false;
}

interface Credentials {
  apiKey?: string;
  jwtToken?: string;
  organizationId?: string;
}

async function promptForCredentials(): Promise<Credentials | null> {
  const key = await password({
    message: 'Paste your Daytona API key (or JWT token)',
    validate(v) {
      if (!v || v.trim().length === 0) return 'Cannot be empty';
      return undefined;
    },
  });
  if (isCancel(key)) {
    log.warn('Daytona setup cancelled.');
    return null;
  }
  const trimmed = key.trim();

  // JWTs start with `eyJ` (base64-encoded `{"`). API keys don't, and don't need
  // an org ID — the SDK derives it from the key. Only ask for org ID for JWTs.
  if (trimmed.startsWith('eyJ')) {
    const org = await text({
      message: 'Paste your Daytona organization ID',
      placeholder: 'org_...',
      validate(v) {
        if (!v || v.trim().length === 0) return 'Cannot be empty';
        return undefined;
      },
    });
    if (isCancel(org)) {
      log.warn('Daytona setup cancelled.');
      return null;
    }
    return { jwtToken: trimmed, organizationId: org.trim() };
  }

  return { apiKey: trimmed };
}

type ValidationResult =
  | { ok: true }
  | { ok: false; kind: 'auth'; message: string }
  | { ok: false; kind: 'network'; message: string };

async function validateCredentials(creds: Credentials): Promise<ValidationResult> {
  const s = spinner();
  s.start('Validating credentials with Daytona');

  // Snapshot existing env so we can restore on failure — never poison
  // process.env with a bad key.
  const snapshot = snapshotManagedEnv();
  applyToEnv(creds);

  try {
    // Dynamic import so the SDK only loads when we actually need it (keeps the
    // Docker hot path lean, same reason as the provider registry).
    const { Daytona } = await import('@daytonaio/sdk');
    const client = new Daytona();
    await client.list();
    s.stop('Daytona credentials accepted');
    return { ok: true };
  } catch (err) {
    restoreManagedEnv(snapshot);
    const message = err instanceof Error ? err.message : String(err);
    s.stop('Daytona credentials check failed');
    if (/401|403|unauthor|forbidden|invalid/i.test(message)) {
      return { ok: false, kind: 'auth', message };
    }
    return { ok: false, kind: 'network', message };
  }
}

function snapshotManagedEnv(): Record<ManagedKey, string | undefined> {
  const out = {} as Record<ManagedKey, string | undefined>;
  for (const k of MANAGED_KEYS) out[k] = process.env[k];
  return out;
}

function restoreManagedEnv(snap: Record<ManagedKey, string | undefined>): void {
  for (const k of MANAGED_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function applyToEnv(creds: Credentials): void {
  // Wipe the other auth method so the SDK doesn't get confused by stale env
  // (e.g. an old JWT lingering from a previous shell export).
  for (const k of MANAGED_KEYS) delete process.env[k];
  if (creds.apiKey) process.env.DAYTONA_API_KEY = creds.apiKey;
  if (creds.jwtToken) process.env.DAYTONA_JWT_TOKEN = creds.jwtToken;
  if (creds.organizationId) process.env.DAYTONA_ORGANIZATION_ID = creds.organizationId;
}

function persistCredentials(creds: Credentials): void {
  applyToEnv(creds);
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });

  // Read existing file, strip any managed keys, append fresh values. Keeps
  // unrelated DAYTONA_API_URL / DAYTONA_TARGET (or anything else the user
  // dropped here) untouched.
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

  const lines: string[] = [];
  if (creds.apiKey) lines.push(`DAYTONA_API_KEY=${creds.apiKey}`);
  if (creds.jwtToken) lines.push(`DAYTONA_JWT_TOKEN=${creds.jwtToken}`);
  if (creds.organizationId) lines.push(`DAYTONA_ORGANIZATION_ID=${creds.organizationId}`);

  const body = (kept ? `${kept}\n` : '') + lines.join('\n') + '\n';

  // Atomic write — rename(2) is atomic on the same filesystem, so partially
  // written secrets can't be left behind on a crash.
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

/** What's currently configured. Used by `daytona login --status`. */
export interface DaytonaCredStatus {
  apiKey?: string;
  jwtToken?: string;
  organizationId?: string;
  source: 'env' | 'secrets.env' | 'none';
}

export function readDaytonaCredStatus(): DaytonaCredStatus {
  // Snapshot what the shell already had before the loader runs so we can
  // distinguish env-from-shell from env-loaded-from-secrets.env.
  const shellHadKey = !!process.env.DAYTONA_API_KEY || !!process.env.DAYTONA_JWT_TOKEN;
  ensureDaytonaEnvLoaded();
  const apiKey = process.env.DAYTONA_API_KEY;
  const jwtToken = process.env.DAYTONA_JWT_TOKEN;
  const organizationId = process.env.DAYTONA_ORGANIZATION_ID;
  if (!apiKey && !jwtToken) return { source: 'none' };
  return {
    apiKey,
    jwtToken,
    organizationId,
    source: shellHadKey ? 'env' : 'secrets.env',
  };
}

export function maskKey(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${'*'.repeat(8)}${value.slice(-4)}`;
}
