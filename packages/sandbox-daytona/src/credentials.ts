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
  text,
} from '@clack/prompts';
import { ensureDaytonaEnvLoaded } from './env-loader.js';

// Ctrl+C at a prompt resolves with the cancel symbol; turn that into a real
// quit so the command never silently continues as if the user answered "No".
function exitOnCancel<T>(v: T | symbol): T {
  if (isCancel(v)) {
    cancel('Cancelled.');
    process.exit(130);
  }
  return v as T;
}

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

  const open = exitOnCancel(
    await confirm({
      message: `Open ${DASHBOARD_KEYS_URL} in your browser?`,
      initialValue: true,
    }),
  );
  if (open) openDashboard();

  // One retry on auth failure (typos are the common case). Beyond that we bail
  // and surface the validation error; the user can re-run `agentbox daytona login`.
  for (let attempt = 0; attempt < 2; attempt++) {
    const creds = await promptForCredentials();

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

async function promptForCredentials(): Promise<Credentials> {
  const key = exitOnCancel(
    await password({
      message: 'Paste your Daytona API key (or JWT token)',
      validate(v) {
        if (!v || v.trim().length === 0) return 'Cannot be empty';
        return undefined;
      },
    }),
  );
  const trimmed = key.trim();

  // JWTs start with `eyJ` (base64-encoded `{"`). API keys don't, and don't need
  // an org ID — the SDK derives it from the key. Only ask for org ID for JWTs.
  if (trimmed.startsWith('eyJ')) {
    const org = exitOnCancel(
      await text({
        message: 'Paste your Daytona organization ID',
        placeholder: 'org_...',
        validate(v) {
          if (!v || v.trim().length === 0) return 'Cannot be empty';
          return undefined;
        },
      }),
    );
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
  // Only the provided auth method's keys are written; `writeManagedSecrets`
  // strips every managed key first, so a stale JWT is cleared when switching to
  // an API key (and vice-versa). Unrelated DAYTONA_API_URL / DAYTONA_TARGET the
  // user dropped in the file stay untouched.
  const record: Record<string, string> = {};
  if (creds.apiKey) record.DAYTONA_API_KEY = creds.apiKey;
  if (creds.jwtToken) record.DAYTONA_JWT_TOKEN = creds.jwtToken;
  if (creds.organizationId) record.DAYTONA_ORGANIZATION_ID = creds.organizationId;
  writeManagedSecrets(MANAGED_KEYS, record);
}

/**
 * Non-interactive credential set (the headless path the hub drives). Accepts
 * either `{ apiKey }` or `{ jwtToken, organizationId }`, validates against
 * Daytona (a cheap `list()`), then persists to `~/.agentbox/secrets.env`. A
 * network failure still persists (offline host isn't blocked) but reports a
 * warning label.
 */
export async function setDaytonaCredentials(
  fields: Record<string, string>,
): Promise<CredSetResult> {
  const apiKey = (fields.apiKey ?? '').trim();
  const jwtToken = (fields.jwtToken ?? '').trim();
  const organizationId = (fields.organizationId ?? '').trim();
  let creds: Credentials;
  if (apiKey) {
    creds = { apiKey };
  } else if (jwtToken && organizationId) {
    creds = { jwtToken, organizationId };
  } else {
    return {
      ok: false,
      error: 'provide apiKey, or jwtToken + organizationId',
      status: { configured: false },
    };
  }
  const result = await validateCredentials(creds);
  if (!result.ok && result.kind === 'auth') {
    return {
      ok: false,
      error: `credentials rejected by Daytona: ${result.message}`,
      status: { configured: false },
    };
  }
  persistCredentials(creds);
  const label = result.ok ? (creds.apiKey ? 'key' : 'jwt') : 'key (unvalidated)';
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
