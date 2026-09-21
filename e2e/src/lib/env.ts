import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/**
 * The user's real home, read from the passwd entry rather than `$HOME`: the harness
 * itself may be launched with an overridden `$HOME`, and every guard below compares
 * against the account's actual home.
 */
export const REAL_HOME = userInfo().homedir;

export const E2E_ROOT = process.env['AGENTBOX_E2E_ROOT'] ?? join(REAL_HOME, '.agentbox-e2e');
export const E2E_HOME = join(E2E_ROOT, 'home');
export const E2E_PREFIX = join(E2E_ROOT, 'prefix');
export const E2E_PACK_DIR = join(E2E_ROOT, 'pack');
export const E2E_WORK = join(E2E_ROOT, 'work');
export const RUNS_DIR = join(REPO_ROOT, 'e2e', 'runs');

/** Never 8787: a collision makes `ensureHub` reclaim the port and kill the user's real hub. */
export const E2E_HUB_PORT = 8797;

export const AGENTBOX_BIN = join(E2E_PREFIX, 'bin', 'agentbox');

// Env vars that tie a spawned CLI to the Claude/Codex session running this harness.
// Left in, every e2e box gets attached to that session as its manager.
const SESSION_ENV = /^(CLAUDECODE|CLAUDE_|CODEX_|OPENCODE_|AGENTBOX_)/;

let ghToken: string | undefined;

function readGhToken(): string {
  if (ghToken) return ghToken;
  // Resolved with the real HOME: gh keeps its login in ~/.config/gh + the Keychain.
  ghToken = execFileSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: REAL_HOME },
  }).trim();
  if (!ghToken) throw new Error('gh auth token returned nothing; run `gh auth login` first');
  return ghToken;
}

/** The environment every e2e child process runs with. */
export function e2eEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SESSION_ENV.test(k)) env[k] = v;
  }
  return {
    ...env,
    HOME: E2E_HOME,
    AGENTBOX_HOME: join(E2E_HOME, '.agentbox'),
    AGENTBOX_RELAY_PORT: String(E2E_HUB_PORT),
    TMUX_TMPDIR: join(E2E_HOME, 'tmux'),
    GH_TOKEN: readGhToken(),
    AGENTBOX_VERCEL_CLI_DIR: join(REAL_HOME, 'Library', 'Application Support', 'com.vercel.cli'),
    PATH: `${join(E2E_PREFIX, 'bin')}:${process.env['PATH'] ?? ''}`,
    NO_COLOR: '1',
    ...extra,
  };
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Refuse to run when the e2e home would be the user's real home. Everything the
 * harness writes (hub, registry, secrets, boxes) goes under E2E_HOME; if that ever
 * resolved to the real home, a teardown would destroy real state.
 */
export function assertIsolatedHome(): void {
  const real = canonical(REAL_HOME);
  const e2e = canonical(E2E_HOME);
  if (e2e === real || real.startsWith(`${e2e}/`)) {
    throw new Error(`refusing to run: e2e home ${e2e} is (or contains) the real home ${real}`);
  }
  if (!e2e.startsWith(`${real}/`) && !e2e.startsWith('/tmp/') && !e2e.startsWith('/private/')) {
    throw new Error(`refusing to run: e2e home ${e2e} is outside the user's home and tmp`);
  }
}
