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
import { confirm, isCancel, intro, log, note, outro, password, select, text } from '@clack/prompts';
import { ensureVercelEnvLoaded, reloadVercelEnv } from './env-loader.js';
import { hasUsableCredentials } from './sdk.js';

const DASHBOARD_TOKENS_URL = 'https://vercel.com/account/settings/tokens';

/**
 * Keys we manage in `~/.agentbox/secrets.env`. On reconfigure we strip prior
 * values for these before appending so the file never accumulates duplicates.
 */
const MANAGED_KEYS = [
  'VERCEL_OIDC_TOKEN',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID',
] as const;

export interface EnsureVercelCredentialsOptions {
  /** Re-prompt even when valid credentials are already present (`agentbox vercel login`). */
  force?: boolean;
}

/**
 * First-run interactive setup for Vercel credentials. The recommended path is
 * OIDC (`vercel link && vercel env pull`), which the SDK reads from env /
 * `.env.local` automatically — for that case the user picks "OIDC" and we just
 * confirm it resolved. The access-token path persists a `VERCEL_TOKEN` trio to
 * `~/.agentbox/secrets.env`.
 *
 * No-op when credentials are already configured. Silent no-op when stdin isn't
 * a TTY so scripted/CI callers get the SDK's "not configured" error instead of
 * a hung prompt.
 */
export async function ensureVercelCredentials(
  opts: EnsureVercelCredentialsOptions = {},
): Promise<void> {
  ensureVercelEnvLoaded();

  if (!opts.force && hasUsableCredentials()) return;
  if (!process.stdin.isTTY) return;

  intro('Vercel setup');
  note(
    `AgentBox needs Vercel credentials to provision sandboxes.\n` +
      `Recommended: run \`vercel link\` then \`vercel env pull\` to get an OIDC token (auto-detected).\n` +
      `Alternative: a personal access token + team id + project id.`,
    'Credentials required',
  );

  const mode = await select({
    message: 'How do you want to authenticate?',
    options: [
      { value: 'oidc', label: 'OIDC token (vercel env pull) — recommended' },
      { value: 'token', label: 'Access token (VERCEL_TOKEN + team + project)' },
    ],
    initialValue: 'oidc',
  });
  if (isCancel(mode)) {
    log.warn('Vercel setup cancelled — re-run `agentbox vercel login` when ready.');
    return;
  }

  if (mode === 'oidc') {
    note(
      `Run these in your project, then re-run this command:\n` +
        `  vercel link\n` +
        `  vercel env pull\n` +
        `This writes VERCEL_OIDC_TOKEN into .env.local (re-pull every ~12h; the dev token expires).`,
      'OIDC setup',
    );
    // Re-read in case the user already pulled the token in another shell.
    reloadVercelEnv();
    if (process.env.VERCEL_OIDC_TOKEN) {
      log.success('Found VERCEL_OIDC_TOKEN — Vercel is configured.');
      outro('Setup complete.');
    } else {
      log.warn('No VERCEL_OIDC_TOKEN found yet — run the commands above, then re-run `agentbox vercel login`.');
    }
    return;
  }

  const creds = await promptForTokenTrio();
  if (creds === null) return;
  persistCredentials(creds);
  log.success(`Vercel credentials saved to ${secretsPath()}`);
  outro('Setup complete.');
}

interface TokenTrio {
  token: string;
  teamId: string;
  projectId: string;
}

async function promptForTokenTrio(): Promise<TokenTrio | null> {
  const openIt = await confirm({
    message: `Open ${DASHBOARD_TOKENS_URL} to create a token?`,
    initialValue: true,
  });
  if (isCancel(openIt)) return null;
  if (openIt) openDashboard();

  const token = await password({
    message: 'Paste your Vercel access token',
    validate: (v) => (v && v.trim().length > 0 ? undefined : 'Cannot be empty'),
  });
  if (isCancel(token)) {
    log.warn('Vercel setup cancelled.');
    return null;
  }
  const teamId = await text({
    message: 'Team ID (team settings → General)',
    placeholder: 'team_...',
    validate: (v) => (v && v.trim().length > 0 ? undefined : 'Cannot be empty'),
  });
  if (isCancel(teamId)) {
    log.warn('Vercel setup cancelled.');
    return null;
  }
  const projectId = await text({
    message: 'Project ID (project settings → General)',
    placeholder: 'prj_...',
    validate: (v) => (v && v.trim().length > 0 ? undefined : 'Cannot be empty'),
  });
  if (isCancel(projectId)) {
    log.warn('Vercel setup cancelled.');
    return null;
  }
  return { token: token.trim(), teamId: teamId.trim(), projectId: projectId.trim() };
}

function persistCredentials(creds: TokenTrio): void {
  // Mirror into process.env so the current run can use them immediately.
  for (const k of MANAGED_KEYS) delete process.env[k];
  process.env.VERCEL_TOKEN = creds.token;
  process.env.VERCEL_TEAM_ID = creds.teamId;
  process.env.VERCEL_PROJECT_ID = creds.projectId;

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

  const lines = [
    `VERCEL_TOKEN=${creds.token}`,
    `VERCEL_TEAM_ID=${creds.teamId}`,
    `VERCEL_PROJECT_ID=${creds.projectId}`,
  ];
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
  // Lazy import keeps node:child_process out of the module's load cost.
  import('node:child_process')
    .then(({ spawnSync }) => {
      const r = spawnSync('open', [DASHBOARD_TOKENS_URL], { stdio: 'ignore' });
      if (r.status !== 0) {
        log.warn(`Could not auto-open the browser — visit ${DASHBOARD_TOKENS_URL} manually.`);
      }
    })
    .catch(() => {
      log.warn(`Could not auto-open the browser — visit ${DASHBOARD_TOKENS_URL} manually.`);
    });
}

export function secretsPath(): string {
  return resolve(homedir(), '.agentbox', 'secrets.env');
}

export interface VercelCredStatus {
  oidc: boolean;
  token?: string;
  teamId?: string;
  projectId?: string;
  source: 'env' | 'secrets.env' | 'none';
}

export function readVercelCredStatus(): VercelCredStatus {
  const shellHad =
    !!process.env.VERCEL_OIDC_TOKEN || !!process.env.VERCEL_TOKEN;
  ensureVercelEnvLoaded();
  const oidc = !!process.env.VERCEL_OIDC_TOKEN;
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!oidc && !token) return { oidc: false, source: 'none' };
  return {
    oidc,
    token,
    teamId,
    projectId,
    source: shellHad ? 'env' : 'secrets.env',
  };
}

export function maskKey(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${'*'.repeat(8)}${value.slice(-4)}`;
}
