import { spawnSync } from 'node:child_process';
import { hostOpenCommand, type CredSetResult } from '@agentbox/sandbox-core';
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
import {
  cancel,
  confirm,
  isCancel,
  intro,
  log,
  note,
  outro,
  password,
  select,
  spinner,
} from '@clack/prompts';
import { loadEffectiveConfig, setConfigValue } from '@agentbox/config';
import { makeDigitalOceanClient, type DigitalOceanProject } from './client.js';
import { ensureDigitalOceanEnvLoaded } from './env-loader.js';
import { resolveProjectChoice } from './preflight.js';

// Ctrl+C at a prompt resolves with the cancel symbol; turn that into a real
// quit so the command never silently continues as if the user answered "No".
function exitOnCancel<T>(v: T | symbol): T {
  if (isCancel(v)) {
    cancel('Cancelled.');
    process.exit(130);
  }
  return v as T;
}

const DASHBOARD_KEYS_URL = 'https://cloud.digitalocean.com/account/api/tokens';

/**
 * Keys we manage in `~/.agentbox/secrets.env`. When the user reconfigures
 * we strip prior values before appending so the file never accumulates
 * duplicates. `DIGITALOCEAN_API_URL` is honored but we don't prompt for it
 * (default endpoint covers 100% of users).
 */
const MANAGED_KEYS = ['DIGITALOCEAN_TOKEN', 'DIGITALOCEAN_API_URL'] as const;
type ManagedKey = (typeof MANAGED_KEYS)[number];

export interface EnsureDigitalOceanCredentialsOptions {
  /** Re-prompt even when valid credentials are already present (used by `agentbox digitalocean login`). */
  force?: boolean;
}

/**
 * First-run interactive setup for DigitalOcean credentials. Walks the user
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
export async function ensureDigitalOceanCredentials(
  opts: EnsureDigitalOceanCredentialsOptions = {},
): Promise<void> {
  ensureDigitalOceanEnvLoaded();

  if (!opts.force && hasUsableCredentials()) return;
  if (!process.stdin.isTTY) return;

  intro('DigitalOcean setup');
  note(
    `AgentBox needs a DigitalOcean Personal Access Token to provision Droplets.\n\n` +
      `1. Open ${DASHBOARD_KEYS_URL}\n` +
      `2. Click "Generate New Token".\n` +
      `3. Give it Read + Write scopes, then copy the token.`,
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
      log.success(`DigitalOcean credentials saved to ${secretsPath()}`);
      await promptForProject(creds);
      outro('Setup complete.');
      return;
    }
    if (result.kind === 'auth' && attempt === 0) {
      log.error(`That token was rejected by DigitalOcean: ${result.message}`);
      log.info('Try again, or press Ctrl-C to cancel.');
      continue;
    }
    if (result.kind === 'network') {
      log.warn(`Could not reach DigitalOcean to validate (${result.message}) — saving anyway.`);
      persistCredentials(creds);
      log.success(`DigitalOcean credentials saved to ${secretsPath()}`);
      outro('Setup complete (unvalidated).');
      return;
    }
    throw new Error(`DigitalOcean credentials rejected: ${result.message}`);
  }
}

/**
 * Offer to pick the DigitalOcean **Project** new boxes land in, right after the
 * token validates — the one moment we hold a known-good token.
 *
 * The choice goes to the **global config** (`box.digitaloceanProject`), not
 * `secrets.env`: it is a placement preference, not a secret, and it has to take
 * part in config layering so a repo can override it in `agentbox.yaml`.
 *
 * Entirely optional. Skipping (or an account with a single project, or a
 * failure to list them) leaves the key unset, which means DigitalOcean's own
 * behavior: everything lands in the account's default project. A network blip
 * here must never fail an otherwise-good login.
 */
async function promptForProject(creds: Credentials): Promise<void> {
  let projects: DigitalOceanProject[];
  try {
    const client = makeDigitalOceanClient({ token: creds.token, endpoint: creds.endpoint });
    projects = await client.listProjects();
  } catch (err) {
    log.warn(
      `Could not list your DigitalOcean projects (${err instanceof Error ? err.message : String(err)}) — ` +
        "boxes will use the account's default project. Set it later with " +
        '`agentbox config set box.digitaloceanProject <name|id>`.',
    );
    return;
  }

  // Nothing to choose between — don't ask a question with one answer.
  if (projects.length < 2) return;

  const current = (await loadEffectiveConfig(process.cwd())).effective.box.digitaloceanProject;
  const choice = exitOnCancel(
    await select({
      message: 'Which DigitalOcean project should new boxes go into?',
      initialValue: current || SKIP_PROJECT,
      options: [
        ...projects.map((p) => ({
          value: p.id,
          label: p.is_default ? `${p.name} (account default)` : p.name,
          hint: p.id,
        })),
        { value: SKIP_PROJECT, label: "Skip — use the account's default project" },
      ],
    }),
  );

  if (choice === SKIP_PROJECT) {
    log.info("Boxes will go into your account's default DigitalOcean project.");
    return;
  }

  await setConfigValue('global', 'box.digitaloceanProject', choice, process.cwd());
  const picked = projects.find((p) => p.id === choice);
  log.success(`New boxes will be created in the "${picked?.name ?? choice}" project.`);
}

const SKIP_PROJECT = '__skip__';

function hasUsableCredentials(): boolean {
  return typeof process.env.DIGITALOCEAN_TOKEN === 'string' && process.env.DIGITALOCEAN_TOKEN.length > 0;
}

interface Credentials {
  token: string;
  endpoint?: string;
}

async function promptForCredentials(): Promise<Credentials> {
  const token = exitOnCancel(
    await password({
      message: 'Paste your DigitalOcean Cloud API token',
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
  s.start('Validating credentials with DigitalOcean');

  try {
    const client = makeDigitalOceanClient({ token: creds.token, endpoint: creds.endpoint });
    // `getAccount()` is a cheap, deterministic call that exercises auth +
    // basic API reachability without provisioning anything.
    await client.getAccount();
    s.stop('DigitalOcean credentials accepted');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop('DigitalOcean credentials check failed');
    if (/401|403|unauthor|forbidden|invalid|token/i.test(message)) {
      return { ok: false, kind: 'auth', message };
    }
    return { ok: false, kind: 'network', message };
  }
}

function persistCredentials(creds: Credentials): void {
  process.env.DIGITALOCEAN_TOKEN = creds.token;
  if (creds.endpoint) process.env.DIGITALOCEAN_API_URL = creds.endpoint;
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

  const lines: string[] = [`DIGITALOCEAN_TOKEN=${creds.token}`];
  if (creds.endpoint) lines.push(`DIGITALOCEAN_API_URL=${creds.endpoint}`);

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

/**
 * Non-interactive credential set (the headless path the hub drives). Validates
 * `{ token, endpoint? }` against the DigitalOcean API (a cheap `getAccount`),
 * then persists to `~/.agentbox/secrets.env`. A network failure still persists
 * (so an offline host isn't blocked) but reports `ok:true` with a warning label.
 */
export async function setDigitalOceanCredentials(
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
    return {
      ok: false,
      error: `token rejected by DigitalOcean: ${result.message}`,
      status: { configured: false },
    };
  }
  persistCredentials(creds);

  // The optional Project field from the hub / tray settings form. It is NOT a
  // secret and must not land in secrets.env: `box.digitaloceanProject` is the
  // single source of truth (it also has to layer, so a repo can override it).
  // Resolve the name to an id here so a typo is reported inline in the form
  // rather than surfacing much later as a failed create.
  const project = (fields.project ?? '').trim();
  if (project.length > 0) {
    try {
      const client = makeDigitalOceanClient({ token: creds.token, endpoint: creds.endpoint });
      const projectId = resolveProjectChoice(project, await client.listProjects());
      await setConfigValue('global', 'box.digitaloceanProject', projectId, process.cwd());
    } catch (err) {
      // The token is already saved and good — only the project is bad, so say
      // exactly that rather than implying the credentials were rejected.
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: { configured: true, label: 'token (project not set)' },
      };
    }
  }

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

export interface DigitalOceanCredStatus {
  token?: string;
  endpoint?: string;
  source: 'env' | 'secrets.env' | 'none';
}

export function readDigitalOceanCredStatus(): DigitalOceanCredStatus {
  const shellHadToken = !!process.env.DIGITALOCEAN_TOKEN;
  ensureDigitalOceanEnvLoaded();
  const token = process.env.DIGITALOCEAN_TOKEN;
  const endpoint = process.env.DIGITALOCEAN_API_URL;
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
