import { confirm, isCancel, log as clog, note } from '@clack/prompts';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { GitPushMode } from '@agentbox/config';
import { GitHubAppLeaser, loadGitHubAppConfig, parseGitRemote } from '@agentbox/relay';
import { hostOpenCommand } from '@agentbox/sandbox-core';

const CP_DIR = join(homedir(), '.agentbox', 'control-plane');
const ENV_PATH = join(CP_DIR, 'control-plane.env');
const META_PATH = join(CP_DIR, 'control-plane.json');
const REPOS_STATE = join(CP_DIR, 'repos.json');

/** Best-effort: open a URL in the host browser (never throws). */
export function openInBrowser(url: string): void {
  try {
    const child = spawn(hostOpenCommand(), [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* caller prints the URL to open manually */
  }
}

interface ControlPlaneMeta {
  appId?: string;
  slug?: string;
  htmlUrl?: string;
  installUrl?: string;
}

export function loadControlPlaneMeta(): ControlPlaneMeta | null {
  try {
    return JSON.parse(readFileSync(META_PATH, 'utf8')) as ControlPlaneMeta;
  } catch {
    return null;
  }
}

/** Load the setup-written App creds (+ admin token) into the env if not already set. */
function loadLocalControlPlaneEnv(): void {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
}

/** Resolve the project's origin into `owner/repo`, or null if absent/unparseable. */
export async function resolveOwnerRepo(projectRoot: string): Promise<{ owner: string; repo: string } | null> {
  const r = await execa('git', ['-C', projectRoot, 'remote', 'get-url', 'origin'], { reject: false });
  const origin = (r.stdout ?? '').trim();
  if (r.exitCode !== 0 || origin.length === 0) return null;
  try {
    const { path } = parseGitRemote(origin);
    const [owner, repo] = path.replace(/\.git$/, '').split('/');
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

/**
 * Whether the GitHub App is installed on owner/repo. Prefers the local App key
 * (works offline); falls back to the plane's admin endpoint; returns 'unknown'
 * when neither credential is available locally.
 */
export async function checkRepoInstalled(
  owner: string,
  repo: string,
  controlPlaneUrl: string | undefined,
): Promise<boolean | 'unknown'> {
  loadLocalControlPlaneEnv();
  const appCfg = loadGitHubAppConfig();
  if (appCfg) {
    try {
      return await new GitHubAppLeaser(appCfg).isRepoInstalled(owner, repo);
    } catch {
      /* fall through to the plane check */
    }
  }
  const adminToken = process.env.AGENTBOX_RELAY_ADMIN_TOKEN;
  if (controlPlaneUrl && adminToken) {
    try {
      const u = `${controlPlaneUrl.replace(/\/$/, '')}/admin/app/repo-installed?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`;
      const res = await fetch(u, {
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return Boolean(((await res.json()) as { installed?: boolean }).installed);
    } catch {
      /* unknown */
    }
  }
  return 'unknown';
}

/** The GitHub page where the user picks repositories for the App installation. */
export function addRepoUrl(meta: ControlPlaneMeta | null): string | null {
  return meta?.installUrl ?? (meta?.slug ? `https://github.com/apps/${meta.slug}/installations/new` : null);
}

type ReposState = Record<string, { installed?: boolean; promptedAt?: string }>;

function readReposState(): ReposState {
  try {
    return JSON.parse(readFileSync(REPOS_STATE, 'utf8')) as ReposState;
  } catch {
    return {};
  }
}
function writeReposState(state: ReposState): void {
  try {
    mkdirSync(CP_DIR, { recursive: true });
    writeFileSync(REPOS_STATE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* best-effort cache; never block a launch on it */
  }
}

/**
 * Before launching an agent against a configured control plane, make sure the
 * project repo is authorized on the GitHub App (else pushes can't lease a
 * token). Checks install status, prompts to open the add-repo page when
 * missing, and remembers the outcome so it never nags again. No-op without a
 * control plane, without an origin, or non-interactively (then it only warns).
 */
export async function ensureProjectRepoOnControlPlane(args: {
  controlPlaneUrl: string | undefined;
  gitPushMode?: GitPushMode;
  projectRoot: string;
  yes?: boolean;
}): Promise<void> {
  const { controlPlaneUrl, projectRoot } = args;
  if (!controlPlaneUrl) return;
  // `relay` and `direct` push modes never lease from the plane, so the repo
  // doesn't need to be authorized on the control plane's GitHub App — skip the
  // check/nag. (`direct` uses credentials copied straight into the box.)
  if (args.gitPushMode === 'relay' || args.gitPushMode === 'direct') return;
  const ownerRepo = await resolveOwnerRepo(projectRoot);
  if (!ownerRepo) return;
  const { owner, repo } = ownerRepo;
  const key = `${controlPlaneUrl.replace(/\/$/, '')}|${owner}/${repo}`;

  const state = readReposState();
  if (state[key]?.installed) return;

  const installed = await checkRepoInstalled(owner, repo, controlPlaneUrl);
  if (installed === true) {
    state[key] = { installed: true };
    writeReposState(state);
    return;
  }
  if (state[key]?.promptedAt) {
    // Already prompted once — don't re-nag with a blocking prompt, but a one-line
    // reminder beats a silent lease failure later. (The live check above still
    // auto-clears this and goes quiet once the repo is actually authorized.)
    clog.warn(
      `${owner}/${repo} isn't authorized on the control plane's GitHub App yet — run \`agentbox hub add\`.`,
    );
    return;
  }

  const meta = loadControlPlaneMeta();
  const url = addRepoUrl(meta);
  const nonInteractive = args.yes === true || process.env.AGENTBOX_PROMPT === 'off' || !process.stdout.isTTY;

  if (nonInteractive) {
    clog.warn(
      `Repo ${owner}/${repo} may not be authorized on the control plane's GitHub App; ` +
        `pushes/PRs will fail to lease until you run \`agentbox hub add\`.`,
    );
    state[key] = { promptedAt: new Date().toISOString() };
    writeReposState(state);
    return;
  }

  if (!url) {
    clog.warn(
      `Repo ${owner}/${repo} isn't authorized on the GitHub App and no App metadata was found locally. ` +
        `Run \`agentbox hub add\` from a machine that ran \`hub setup\`.`,
    );
    state[key] = { promptedAt: new Date().toISOString() };
    writeReposState(state);
    return;
  }

  const ok = await confirm({
    message: `Authorize ${owner}/${repo} on the GitHub App so this box can push / open PRs?`,
    initialValue: true,
  });
  if (!isCancel(ok) && ok) {
    openInBrowser(url);
    note(`Opened ${url}\nSelect ${owner}/${repo}, approve, then return here.`, 'GitHub App');
  }
  state[key] = { promptedAt: new Date().toISOString() };
  writeReposState(state);
}
