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
  text,
} from '@clack/prompts';
import {
  DEFAULT_ISLO_COMPUTE_URL,
  hasUsableCredentials,
  resolveBaseUrl,
  resolveControlUrl,
} from './api.js';
import { ensureIsloEnvLoaded, reloadIsloEnv } from './env-loader.js';

const DOCS_URL = 'https://docs.islo.dev/cli/authentication#api-key-authentication';
const MANAGED_KEYS = ['AGENTBOX_ISLO_API_KEY', 'AGENTBOX_ISLO_BASE_URL'] as const;

function exitOnCancel<T>(v: T | symbol): T {
  if (isCancel(v)) {
    cancel('Cancelled.');
    process.exit(130);
  }
  return v as T;
}

export interface EnsureIsloCredentialsOptions {
  force?: boolean;
}

export async function ensureIsloCredentials(
  opts: EnsureIsloCredentialsOptions = {},
): Promise<void> {
  ensureIsloEnvLoaded();
  if (!opts.force && hasUsableCredentials()) return;
  if (!process.stdin.isTTY) return;

  intro('Islo setup');
  note(
    'AgentBox needs an Islo API key to provision Islo-backed boxes.\n' +
      'Create one with `islo api-key create <name> --show`, then paste it below.\n' +
      'The key is stored in `~/.agentbox/secrets.env` (mode 0600).',
    'Credentials required',
  );

  const openIt = exitOnCancel(
    await confirm({
      message: `Open ${DOCS_URL} for API-key docs?`,
      initialValue: false,
    }),
  );
  if (openIt) openDocs();

  const key = exitOnCancel(
    await password({
      message: 'Paste your Islo API key',
      validate: (v) => (v && v.trim().length > 0 ? undefined : 'Cannot be empty'),
    }),
  );

  const baseUrl = exitOnCancel(
    await text({
      message: 'Islo API base URL',
      initialValue: process.env.AGENTBOX_ISLO_BASE_URL ?? process.env.ISLO_BASE_URL ?? DEFAULT_ISLO_COMPUTE_URL,
      validate: (v) => (v && /^https?:\/\//u.test(v.trim()) ? undefined : 'Enter an http(s) URL'),
    }),
  );

  persistCredentials({ apiKey: key.trim(), baseUrl: String(baseUrl).trim() });
  reloadIsloEnv();
  log.success(`Islo credentials saved to ${secretsPath()}`);
  outro('Setup complete.');
}

function persistCredentials(creds: { apiKey: string; baseUrl: string }): void {
  const record: Record<string, string> = { AGENTBOX_ISLO_API_KEY: creds.apiKey };
  if (creds.baseUrl && creds.baseUrl !== DEFAULT_ISLO_COMPUTE_URL) {
    record.AGENTBOX_ISLO_BASE_URL = creds.baseUrl;
  }
  writeManaged(record);
}

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
    // best-effort
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

function openDocs(): void {
  import('node:child_process')
    .then(({ spawnSync }) => {
      const r = spawnSync(hostOpenCommand(), [DOCS_URL], { stdio: 'ignore' });
      if (r.status !== 0) log.warn(`Could not auto-open the browser — visit ${DOCS_URL} manually.`);
    })
    .catch(() => {
      log.warn(`Could not auto-open the browser — visit ${DOCS_URL} manually.`);
    });
}

export function secretsPath(): string {
  return resolve(homedir(), '.agentbox', 'secrets.env');
}

export interface IsloCredStatus {
  auth: 'key' | 'none';
  token?: string;
  baseUrl: string;
  controlUrl: string;
  source: 'env' | 'secrets.env' | 'none';
}

export function readIsloCredStatus(): IsloCredStatus {
  const shellHad =
    process.env.AGENTBOX_ISLO_API_KEY !== undefined || process.env.ISLO_API_KEY !== undefined;
  ensureIsloEnvLoaded();
  const key = process.env.AGENTBOX_ISLO_API_KEY ?? process.env.ISLO_API_KEY;
  if (!key) {
    return {
      auth: 'none',
      source: 'none',
      baseUrl: resolveBaseUrl(),
      controlUrl: resolveControlUrl(),
    };
  }
  return {
    auth: 'key',
    token: key,
    source: shellHad ? 'env' : 'secrets.env',
    baseUrl: resolveBaseUrl(),
    controlUrl: resolveControlUrl(),
  };
}

export function maskKey(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${'*'.repeat(8)}${value.slice(-4)}`;
}
