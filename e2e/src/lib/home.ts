import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { E2E_HOME, E2E_HUB_PORT, E2E_PREFIX, REAL_HOME, assertIsolatedHome } from './env.js';

const REAL_STATE = join(REAL_HOME, '.agentbox');
const STATE = join(E2E_HOME, '.agentbox');

/** Same filtered set `scripts/hub-test-vm.sh creds` copies: provider keys only, never the whole file. */
const PROVIDER_KEYS = [
  'HCLOUD_TOKEN',
  'HCLOUD_ENDPOINT',
  'E2B_API_KEY',
  'E2B_DOMAIN',
  'DAYTONA_API_KEY',
  'DAYTONA_JWT_TOKEN',
  'DAYTONA_ORGANIZATION_ID',
  'DAYTONA_API_URL',
  'DAYTONA_TARGET',
  'VERCEL_TOKEN',
  'VERCEL_OIDC_TOKEN',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID',
  'VERCEL_AUTH_SOURCE',
];

const AGENT_CRED_FILES = [
  'claude-credentials.json',
  'codex-credentials.json',
  'opencode-credentials.json',
];

/**
 * Host-side agent config the CLI reads when seeding a box (logins, settings). Linked,
 * not copied, so an e2e run sees exactly what the user's own `agentbox claude` would.
 */
const LINKED = [
  '.claude',
  '.claude.json',
  '.docker',
  '.codex',
  '.config/opencode',
  '.local/share/opencode',
];

export interface HomeOptions {
  /** Keep the previous run's `<provider>-prepared.json` so S1 can skip the bake. */
  reuseBake: boolean;
}

export function readSecretsEnv(path = join(REAL_STATE, 'secrets.env')): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1]) out.set(m[1], (m[2] ?? '').replace(/^"(.*)"$/, '$1'));
  }
  return out;
}

/**
 * Build a fresh e2e `$HOME`. Wipes the previous one (keeping prepared-state files on
 * `--reuse-bake`), then seeds only what a logged-in user would have: provider keys,
 * agent-login backups, the agent config dirs, a git identity and a login-shell profile
 * that puts the e2e install first on PATH (the tray shells `zsh -lc agentbox`).
 */
export function bootstrapHome(opts: HomeOptions): void {
  assertIsolatedHome();

  const kept = new Map<string, Buffer>();
  if (opts.reuseBake && existsSync(STATE)) {
    for (const f of readdirSync(STATE)) {
      if (f.endsWith('-prepared.json')) kept.set(f, readFileSync(join(STATE, f)));
    }
  }
  const keptConfig =
    opts.reuseBake && existsSync(join(STATE, 'config.yaml'))
      ? readFileSync(join(STATE, 'config.yaml'), 'utf8')
      : undefined;

  rmSync(E2E_HOME, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  mkdirSync(join(E2E_HOME, 'tmux'), { recursive: true, mode: 0o700 });

  for (const [f, buf] of kept) writeFileSync(join(STATE, f), buf);

  writeFileSync(join(STATE, 'config.yaml'), stringify(e2eConfig(keptConfig)));

  const secrets = readSecretsEnv();
  const lines = PROVIDER_KEYS.filter((k) => secrets.has(k)).map((k) => `${k}=${secrets.get(k)}`);
  writeFileSync(join(STATE, 'secrets.env'), `${lines.join('\n')}\n`, { mode: 0o600 });

  for (const f of AGENT_CRED_FILES) {
    const src = join(REAL_STATE, f);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(STATE, f));
    chmodSync(join(STATE, f), 0o600);
  }
  // A missing marker makes every command start the (TTY-only) install wizard.
  writeFileSync(
    join(STATE, 'setup-complete.json'),
    JSON.stringify({ completedAt: new Date().toISOString(), provider: 'docker' }),
  );

  for (const rel of LINKED) {
    const src = join(REAL_HOME, rel);
    if (!existsSync(src)) continue;
    const dest = join(E2E_HOME, rel);
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(src, dest);
  }

  const git = (key: string): string => {
    try {
      return execFileSync('git', ['config', '--global', key], {
        encoding: 'utf8',
        env: { ...process.env, HOME: REAL_HOME },
      }).trim();
    } catch {
      return '';
    }
  };
  writeFileSync(
    join(E2E_HOME, '.gitconfig'),
    [
      '[user]',
      `\tname = ${git('user.name') || 'AgentBox E2E'}`,
      `\temail = ${git('user.email') || 'e2e@agent-box.sh'}`,
      '[credential "https://github.com"]',
      '\thelper = !gh auth git-credential',
      '[init]',
      '\tdefaultBranch = main',
      '[commit]',
      '\tgpgsign = false',
      '',
    ].join('\n'),
  );
  writeFileSync(join(E2E_HOME, '.zprofile'), `export PATH="${join(E2E_PREFIX, 'bin')}:$PATH"\n`);
}

function e2eConfig(previous: string | undefined): Record<string, unknown> {
  // Keep the image pins a previous bake wrote (`box.image<Provider>`), nothing else.
  const box: Record<string, unknown> = {};
  if (previous) {
    for (const line of previous.split('\n')) {
      const m = /^\s+(image[A-Z][A-Za-z]*):\s*(\S+)/.exec(line);
      if (m?.[1] && m[2]) box[m[1]] = m[2];
    }
  }
  return {
    schema: 1,
    relay: { port: E2E_HUB_PORT },
    // Portless is a machine-wide proxy on 80/443; S4 checks the loopback URL instead.
    portless: { enabled: false },
    box: {
      ...box,
      // The per-agent config volumes are engine-global; an e2e box must not write the user's.
      isolateClaudeConfig: true,
      isolateCodexConfig: true,
      isolateOpencodeConfig: true,
    },
    queue: { maxConcurrent: 8 },
    autopause: { maxRunningBoxes: 20 },
  };
}
