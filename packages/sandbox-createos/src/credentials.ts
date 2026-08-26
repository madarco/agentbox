import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { hostOpenCommand, writeManagedSecrets, type CredSetResult } from '@agentbox/sandbox-core';
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
import { CreateOsClient } from './client.js';
import { ensureCreateOsEnvLoaded, reloadCreateOsEnv } from './env-loader.js';

const DASHBOARD_KEYS_URL = 'https://createos.sh';
const MANAGED_KEYS = ['CREATEOS_API_KEY'] as const;

export interface EnsureCreateOsCredentialsOptions {
  force?: boolean;
}

export interface CreateOsCredStatus {
  auth: 'key' | 'none';
  token?: string;
  source: 'env' | 'secrets.env' | 'none';
}

function exitOnCancel<T>(v: T | symbol): T {
  if (isCancel(v)) {
    cancel('Cancelled.');
    process.exit(130);
  }
  return v as T;
}

export async function ensureCreateOsCredentials(
  opts: EnsureCreateOsCredentialsOptions = {},
): Promise<void> {
  ensureCreateOsEnvLoaded();
  if (!opts.force && readCreateOsCredStatus().auth !== 'none') return;
  if (!process.stdin.isTTY) return;

  intro('CreateOS setup');
  note(
    'AgentBox needs a CreateOS API key to provision sandboxes. The key is stored in `~/.agentbox/secrets.env`.',
    'Credentials required',
  );
  const openIt = exitOnCancel(
    await confirm({ message: `Open ${DASHBOARD_KEYS_URL} to create a key?`, initialValue: true }),
  );
  if (openIt) openDashboard();
  const key = exitOnCancel(
    await password({
      message: 'Paste your CreateOS API key',
      validate: (v) => (v.trim().length > 0 ? undefined : 'Cannot be empty'),
    }),
  );
  persistCredentials(key.trim());
  reloadCreateOsEnv();
  log.success(`CreateOS credentials saved to ${secretsPath()}`);
  outro('Setup complete.');
}

export function setCreateOsCredentials(fields: Record<string, string>): CredSetResult {
  const apiKey = (fields.apiKey ?? '').trim();
  if (!apiKey) return { ok: false, error: 'apiKey is required', status: { configured: false } };
  persistCredentials(apiKey);
  const cred = readCreateOsCredStatus();
  return { ok: true, status: { configured: cred.auth !== 'none', label: cred.auth } };
}

export async function validateCreateOsCredentials(): Promise<boolean> {
  try {
    await new CreateOsClient().whoami();
    return true;
  } catch {
    return false;
  }
}

function persistCredentials(apiKey: string): void {
  writeManagedSecrets(MANAGED_KEYS, { CREATEOS_API_KEY: apiKey });
}

function openDashboard(): void {
  import('node:child_process')
    .then(({ spawnSync }) => {
      const r = spawnSync(hostOpenCommand(), [DASHBOARD_KEYS_URL], { stdio: 'ignore' });
      if (r.status !== 0) log.warn(`Could not auto-open the browser - visit ${DASHBOARD_KEYS_URL} manually.`);
    })
    .catch(() => {
      log.warn(`Could not auto-open the browser - visit ${DASHBOARD_KEYS_URL} manually.`);
    });
}

export function readCreateOsCredStatus(): CreateOsCredStatus {
  const shellHad = process.env.CREATEOS_API_KEY !== undefined;
  ensureCreateOsEnvLoaded();
  const key = process.env.CREATEOS_API_KEY;
  if (!key) return { auth: 'none', source: 'none' };
  return { auth: 'key', token: key, source: shellHad ? 'env' : 'secrets.env' };
}

export function secretsPath(): string {
  return resolve(homedir(), '.agentbox', 'secrets.env');
}

export function maskKey(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${'*'.repeat(8)}${value.slice(-4)}`;
}
