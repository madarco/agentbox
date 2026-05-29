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
  confirm,
  isCancel,
  intro,
  log,
  note,
  outro,
  password,
  select,
  spinner,
  text,
} from '@clack/prompts';
import { ensureVercelEnvLoaded, reloadVercelEnv } from './env-loader.js';
import { hasUsableCredentials } from './sdk.js';
import { cliStorePaths, isNearExpiry, readCliAuth, readCliCurrentTeam } from './cli-store.js';
import { detectSbx, installSbx, installSbxHint, loginSbx, resetSbxCache } from './sbx-cli.js';
import { createProject, getUser, listProjects, type VercelProject } from './vercel-rest.js';

const DASHBOARD_TOKENS_URL = 'https://vercel.com/account/settings/tokens';

/**
 * Keys we manage in `~/.agentbox/secrets.env`. On reconfigure we strip prior
 * values for these before appending so the file never accumulates duplicates.
 * `VERCEL_AUTH_SOURCE` is the CLI-login marker; the access token itself is never
 * stored here in that mode (it's read live from the Vercel CLI store).
 */
const MANAGED_KEYS = [
  'VERCEL_OIDC_TOKEN',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID',
  'VERCEL_AUTH_SOURCE',
] as const;

export interface EnsureVercelCredentialsOptions {
  /** Re-prompt even when valid credentials are already present (`agentbox vercel login`). */
  force?: boolean;
}

/**
 * First-run interactive setup for Vercel credentials. The access-token path
 * persists a `VERCEL_TOKEN` trio to `~/.agentbox/secrets.env` (the canonical
 * store, matching daytona/hetzner). OIDC is also supported, but the token must
 * be present in the shell env or in `~/.agentbox/secrets.env` — agentbox does
 * NOT harvest `.env.local` (that file belongs to the app being developed).
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
      `Sign in with Vercel (recommended): drives the Vercel \`sandbox\` CLI through a browser login, then reads the token from the CLI's own store and keeps it fresh — no token to paste.\n` +
      `Access token (best for CI / headless): personal access token + team id + project id, saved to \`~/.agentbox/secrets.env\`.\n` +
      `OIDC (short interactive work): export VERCEL_OIDC_TOKEN in your shell or add it to \`~/.agentbox/secrets.env\` (dev token expires ~12h, no headless refresh).`,
    'Credentials required',
  );

  const mode = await select({
    message: 'How do you want to authenticate?',
    options: [
      { value: 'cli', label: 'Sign in with Vercel (browser) — recommended for interactive use' },
      { value: 'token', label: 'Access token (VERCEL_TOKEN + team + project) — best for CI / headless' },
      { value: 'oidc', label: 'OIDC token (VERCEL_OIDC_TOKEN in env / secrets.env) — short interactive work' },
    ],
    initialValue: 'cli',
  });
  if (isCancel(mode)) {
    log.warn('Vercel setup cancelled — re-run `agentbox vercel login` when ready.');
    return;
  }

  if (mode === 'cli') {
    await runCliLogin();
    return;
  }

  if (mode === 'oidc') {
    note(
      `Get an OIDC token with \`vercel link\` then \`vercel env pull\`, then make it visible to AgentBox by either:\n` +
        `  export VERCEL_OIDC_TOKEN=<token>   # in this shell\n` +
        `  echo "VERCEL_OIDC_TOKEN=<token>" >> ~/.agentbox/secrets.env\n` +
        `Re-do every ~12h; the dev token expires. AgentBox does not harvest .env.local.`,
      'OIDC setup',
    );
    // Re-read in case the user already added the token to secrets.env.
    reloadVercelEnv();
    if (process.env.VERCEL_OIDC_TOKEN) {
      log.success('Found VERCEL_OIDC_TOKEN — Vercel is configured.');
      await ensureSbxInstalled();
      outro('Setup complete.');
    } else {
      log.warn('No VERCEL_OIDC_TOKEN found yet — set it as above, then re-run `agentbox vercel login`.');
    }
    return;
  }

  const creds = await promptForTokenTrio();
  if (creds === null) return;
  persistCredentials(creds);
  log.success(`Vercel credentials saved to ${secretsPath()}`);
  await ensureSbxInstalled();
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
  writeManaged({
    VERCEL_TOKEN: creds.token,
    VERCEL_TEAM_ID: creds.teamId,
    VERCEL_PROJECT_ID: creds.projectId,
  });
}

/**
 * Persist the CLI-login marker + cached stable ids. The access token is
 * deliberately omitted — it's read live from the Vercel CLI store on each call
 * and refreshed there, so the only thing we cache is the team/project scope.
 */
function persistCliCredentials(ids: { teamId: string; projectId: string }): void {
  writeManaged({
    VERCEL_AUTH_SOURCE: 'cli',
    VERCEL_TEAM_ID: ids.teamId,
    VERCEL_PROJECT_ID: ids.projectId,
  });
}

/**
 * Atomically rewrite the managed Vercel keys in `~/.agentbox/secrets.env`:
 * strip every prior value for a `MANAGED_KEYS` entry, then append exactly the
 * keys in `record` (mode 0600, temp-file + rename). Also mirrors the record
 * into `process.env` (and clears the other managed keys there) so the current
 * run uses the new values immediately.
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

/**
 * The full CLI-login flow: make sure the Vercel `sandbox` CLI is installed (offer
 * to install it), run its browser OAuth, harvest the team id from the CLI store,
 * let the user pick a project to scope sandboxes to, and persist the marker +
 * ids. The access token is never stored — `resolveCredentials` reads it live.
 */
/**
 * Make sure the Vercel `sandbox` CLI is on PATH, offering to install it. Every
 * login mode ensures it because interactive attach (`agentbox shell|claude|
 * codex|opencode` on a vercel box) drives `sbx exec` for a real PTY. Returns the
 * resolved bin, or null if absent / declined / install failed (callers warn).
 */
async function ensureSbxInstalled(): Promise<{ bin: string } | null> {
  let det = await detectSbx();
  if (!det.installed) {
    const doInstall = await confirm({
      message: `The Vercel sandbox CLI (needed for interactive attach) isn't installed. Install it now? (${installSbxHint()})`,
      initialValue: true,
    });
    if (isCancel(doInstall) || !doInstall) {
      log.warn(
        `Install it with \`${installSbxHint()}\` to use \`agentbox shell|claude|codex|opencode\` on Vercel boxes.`,
      );
      return null;
    }
    const sp = spinner();
    sp.start('Installing the Vercel sandbox CLI…');
    const ok = await installSbx();
    resetSbxCache();
    det = await detectSbx();
    if (!ok || !det.installed || !det.bin) {
      sp.stop('Install failed.');
      log.warn(`Could not install the sandbox CLI — run \`${installSbxHint()}\` manually.`);
      return null;
    }
    sp.stop(`Installed sandbox CLI${det.version ? ` ${det.version}` : ''}.`);
  }
  return det.bin ? { bin: det.bin } : null;
}

async function runCliLogin(): Promise<void> {
  const det = await ensureSbxInstalled();
  if (!det) {
    log.warn('The Vercel sandbox CLI is required to sign in this way — install it, then re-run `agentbox vercel login`.');
    return;
  }

  note('A browser window will open to sign in to Vercel.', 'Vercel sign-in');
  const status = loginSbx(det.bin);
  if (status !== 0) {
    log.warn('Vercel sign-in did not complete — re-run `agentbox vercel login` to try again.');
    return;
  }

  const harvested = harvestCliCredentials();
  if (!harvested) {
    log.warn('Sign-in finished but no credentials were found in the Vercel CLI store. Try again.');
    return;
  }

  // Validate the token early so a bad/expired session fails here, not mid-op.
  try {
    await getUser(harvested.token);
  } catch (err) {
    log.warn(
      `The Vercel session looks invalid (${err instanceof Error ? err.message : String(err)}). ` +
        'Re-run `agentbox vercel login`.',
    );
    return;
  }

  const projectId = await resolveProjectId(harvested.token, harvested.teamId);
  if (projectId === null) {
    log.warn('No project selected — re-run `agentbox vercel login` to finish setup.');
    return;
  }

  persistCliCredentials({ teamId: harvested.teamId, projectId });
  reloadVercelEnv();
  log.success(`Signed in with Vercel — credentials managed by the sandbox CLI (saved scope to ${secretsPath()}).`);
  outro('Setup complete.');
}

/**
 * Read the live token + team id from the Vercel CLI store. teamId prefers an
 * already-cached `VERCEL_TEAM_ID` (e.g. from a prior login) and falls back to
 * the CLI's `currentTeam`. Null when the CLI isn't logged in.
 */
function harvestCliCredentials(): { token: string; teamId: string } | null {
  const auth = readCliAuth();
  if (!auth) return null;
  const teamId = process.env.VERCEL_TEAM_ID ?? readCliCurrentTeam();
  if (!teamId) return null;
  return { token: auth.token, teamId };
}

/**
 * Pick the Vercel project sandboxes run under. Lists the team's projects in a
 * clack select (pre-selecting an existing `agentbox` / sandbox-default project),
 * plus a "create a new project" entry. Returns the project id, or null if the
 * user cancelled. Non-interactive callers reuse/create an `agentbox` project.
 */
async function resolveProjectId(token: string, teamId: string): Promise<string | null> {
  let projects: VercelProject[] = [];
  const sp = spinner();
  sp.start('Loading your Vercel projects…');
  try {
    projects = await listProjects(token, teamId);
    sp.stop(`Found ${projects.length} project${projects.length === 1 ? '' : 's'}.`);
  } catch (err) {
    sp.stop('Could not list projects.');
    log.warn(`Failed to list Vercel projects: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const CREATE = '__create__';
  const preferred =
    projects.find((p) => p.name === 'agentbox') ??
    projects.find((p) => p.name === 'vercel-sandbox-default-project');
  const choice = await select({
    message: 'Which Vercel project should sandboxes run under?',
    options: [
      ...projects.map((p) => ({ value: p.id, label: p.name })),
      { value: CREATE, label: 'Create a new project…' },
    ],
    initialValue: preferred ? preferred.id : CREATE,
  });
  if (isCancel(choice)) return null;

  if (choice !== CREATE) return choice;

  const name = await text({
    message: 'New project name',
    placeholder: 'agentbox',
    defaultValue: 'agentbox',
    validate: (v) => (v && v.trim().length > 0 ? undefined : 'Cannot be empty'),
  });
  if (isCancel(name)) return null;
  try {
    const created = await createProject(token, teamId, name.trim() || 'agentbox');
    return created.id;
  } catch (err) {
    log.warn(`Could not create the project: ${err instanceof Error ? err.message : String(err)}`);
    return null;
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
  /** Which auth mode is configured. */
  auth: 'oidc' | 'cli' | 'token' | 'none';
  /** Legacy alias kept for callers that branch on OIDC. */
  oidc: boolean;
  token?: string;
  teamId?: string;
  projectId?: string;
  source: 'env' | 'secrets.env' | 'cli-store' | 'none';
  /**
   * CLI mode only: details about the live Vercel CLI session. Whether the
   * `sandbox` CLI is *installed* needs an async probe (`detectSbx`) and is not
   * reported here — the status printer probes it separately.
   */
  cli?: {
    /** A logged-in session was found in the CLI store. */
    loggedIn: boolean;
    /** Unix seconds the live access token expires at, when known. */
    expiresAt?: number;
    /** True when the token is at/near expiry (a refresh would fire). */
    nearExpiry?: boolean;
    /** Path to the CLI's `auth.json`. */
    authPath: string;
  };
}

export function readVercelCredStatus(): VercelCredStatus {
  const shellHad = !!process.env.VERCEL_OIDC_TOKEN || !!process.env.VERCEL_TOKEN;
  ensureVercelEnvLoaded();
  const oidc = !!process.env.VERCEL_OIDC_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;

  if (oidc) {
    return { auth: 'oidc', oidc: true, teamId, projectId, source: shellHad ? 'env' : 'secrets.env' };
  }

  if (process.env.VERCEL_AUTH_SOURCE === 'cli') {
    const auth = readCliAuth();
    return {
      auth: 'cli',
      oidc: false,
      token: auth?.token,
      teamId,
      projectId,
      source: 'cli-store',
      cli: {
        loggedIn: !!auth,
        expiresAt: auth?.expiresAt,
        nearExpiry: auth ? isNearExpiry(auth) : undefined,
        authPath: cliStorePaths().authPath,
      },
    };
  }

  const token = process.env.VERCEL_TOKEN;
  if (!token) return { auth: 'none', oidc: false, source: 'none' };
  return {
    auth: 'token',
    oidc: false,
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
