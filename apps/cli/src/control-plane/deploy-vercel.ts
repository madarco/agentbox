import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGitDeployment,
  createGitProject,
  deleteProject,
  getDeployment,
  getProductionAlias,
  getProject,
  patchProjectSettings,
  projectHasEnv,
  resolveVercelApiAuth,
  upsertProjectEnv,
  type VercelProjectFull,
} from '@agentbox/sandbox-vercel';
import { ensureFork, ghAvailable, ghLogin, ownerOf } from './github-fork.js';
import { openInBrowser } from './ensure-repo-installed.js';

/**
 * Deploy the control plane to Vercel **from GitHub**, in tiers so it works for
 * everyone without a local checkout:
 *   1. If the deployer doesn't own `repo`, `gh`-fork it to their account.
 *   2. API deploy the owned/forked repo (headless; needs the Vercel GitHub App).
 *   3. Fallback: open the Vercel Deploy Button (clones the repo into the user's
 *      account + installs the App + provisions Postgres in-browser), then finish
 *      via the API (set the secrets + redeploy) — no manual paste.
 */
export interface VercelDeployOptions {
  /** App env baked into the build: GITHUB_APP_ID / _PRIVATE_KEY / ADMIN_TOKEN. */
  env: Record<string, string>;
  /** `owner/name` GitHub slug to deploy from. */
  repo: string;
  /** Branch / tag / sha to build. */
  ref: string;
  project?: string;
  log: (line: string) => void;
}

const PROJECT_DEFAULT = 'agentbox-control-plane';
const ROOT_DIRECTORY = 'apps/hub';

/** Raised when Vercel can't connect the repo (GitHub App not installed on the owner). */
class GitConnectError extends Error {}

function connectedTo(p: VercelProjectFull | null, repo: string): boolean {
  return (
    !!p?.link &&
    p.link.type === 'github' &&
    `${p.link.org ?? ''}/${p.link.repo ?? ''}`.toLowerCase() === repo.toLowerCase()
  );
}

function isConnectError(msg: string): boolean {
  return /install the GitHub integration|integration first|github integration/i.test(msg);
}

/** Best-effort Neon provisioning via the logged-in `vercel` CLI, in a temp cwd. */
function provisionNeon(teamId: string | undefined, projectId: string, log: (l: string) => void): Promise<void> {
  return new Promise((resolve) => {
    const work = mkdtempSync(join(tmpdir(), 'agentbox-neon-'));
    const env = { ...process.env, VERCEL_PROJECT_ID: projectId, ...(teamId ? { VERCEL_ORG_ID: teamId } : {}) };
    const child = spawn('vercel', ['integration', 'add', 'neon', '--non-interactive'], {
      cwd: work,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (c: Buffer): void => {
      for (const l of c.toString('utf8').split(/\r?\n/)) if (l.trim()) log(`neon: ${l.trim()}`);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const done = (): void => {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      resolve();
    };
    child.on('error', (e) => {
      log(`neon: could not run \`vercel integration add neon\` (${e.message}) — continuing`);
      done();
    });
    child.on('close', (code) => {
      if (code !== 0) log(`neon: integration add exited ${String(code)} — continuing (it may already be attached)`);
      done();
    });
  });
}

async function pollDeployment(
  token: string,
  teamId: string | undefined,
  id: string,
  log: (l: string) => void,
): Promise<void> {
  const stop = Date.now() + 20 * 60_000;
  let last = '';
  while (Date.now() < stop) {
    const d = await getDeployment(token, teamId, id);
    if (d.readyState !== last) {
      log(`build: ${d.readyState.toLowerCase()}`);
      last = d.readyState;
    }
    if (d.readyState === 'READY') return;
    if (d.readyState === 'ERROR' || d.readyState === 'CANCELED' || d.readyState === 'BLOCKED') {
      throw new Error(
        `Vercel build ${d.readyState.toLowerCase()}${d.errorStep ? ` at ${d.errorStep}` : ''}: ${d.errorMessage ?? 'see the Vercel dashboard'}`,
      );
    }
    await new Promise((r) => setTimeout(r, 6_000));
  }
  throw new Error('timed out waiting for the Vercel build to finish');
}

function envVars(env: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

interface DeployArgs {
  token: string;
  teamId: string | undefined;
  repo: string;
  ref: string;
  env: Record<string, string>;
  projectName: string;
  log: (line: string) => void;
}

/** Headless API deploy of a repo Vercel can connect (owned/forked). */
async function apiDeploy(a: DeployArgs): Promise<{ url: string }> {
  const [owner, repoName] = a.repo.split('/');
  a.log(`ensuring Vercel project "${a.projectName}" is connected to ${a.repo}…`);
  let project = await getProject(a.token, a.teamId, a.projectName);
  if (project && !connectedTo(project, a.repo)) {
    a.log(`project exists but is not connected to ${a.repo}; recreating…`);
    await deleteProject(a.token, a.teamId, project.id);
    project = null;
  }
  if (!project) {
    try {
      project = await createGitProject(a.token, a.teamId, {
        name: a.projectName,
        repo: a.repo,
        rootDirectory: ROOT_DIRECTORY,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isConnectError(msg)) throw new GitConnectError(msg);
      throw e;
    }
  } else {
    await patchProjectSettings(a.token, a.teamId, project.id, {
      framework: 'nextjs',
      rootDirectory: ROOT_DIRECTORY,
    });
  }

  // Idempotent: only provision Neon when the project has no Postgres yet —
  // re-running otherwise provisions an orphan Neon that collides on the
  // already-present POSTGRES_URL_NON_POOLING.
  if (await projectHasEnv(a.token, a.teamId, project.id, 'POSTGRES_URL')) {
    a.log('Postgres already attached — skipping Neon provisioning');
  } else {
    a.log('provisioning Neon Postgres…');
    await provisionNeon(a.teamId, project.id, a.log);
  }
  a.log('setting environment variables…');
  await upsertProjectEnv(a.token, a.teamId, project.id, envVars(a.env));

  a.log(`triggering a production build of ${a.repo}@${a.ref}…`);
  const dep = await createGitDeployment(a.token, a.teamId, {
    name: a.projectName,
    projectId: project.id,
    owner: owner!,
    repo: repoName!,
    ref: a.ref,
  });
  await pollDeployment(a.token, a.teamId, dep.id, a.log);
  const alias = (await getProductionAlias(a.token, a.teamId, project.id)) ?? dep.url ?? null;
  if (!alias) throw new Error('build is ready but no production URL was found');
  return { url: alias.startsWith('http') ? alias : `https://${alias}` };
}

function deployButtonUrl(repo: string, projectName: string): string {
  const p = new URLSearchParams({
    'repository-url': `https://github.com/${repo}`,
    'root-directory': ROOT_DIRECTORY,
    stores: '[{"type":"postgres"}]',
    'project-name': projectName,
    'repository-name': projectName,
  });
  return `https://vercel.com/new/clone?${p.toString()}`;
}

/**
 * Fallback when Vercel can't connect the repo via the API (App not installed):
 * the Deploy Button does the clone + App install + Postgres in-browser; we then
 * set the secrets + redeploy via the API (the control plane boots gracefully
 * unconfigured in the meantime).
 */
async function buttonDeploy(a: DeployArgs): Promise<{ url: string }> {
  const url = deployButtonUrl(a.repo, a.projectName);
  a.log(`opening the Vercel Deploy Button — complete the clone + Postgres setup in your browser:`);
  a.log(url);
  openInBrowser(url);

  a.log('waiting for the Vercel project to appear (finish the deploy in the browser)…');
  const stop = Date.now() + 10 * 60_000;
  let project: VercelProjectFull | null = null;
  while (Date.now() < stop) {
    project = await getProject(a.token, a.teamId, a.projectName);
    if (project?.link?.type === 'github' && project.link.repo) break;
    project = null;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  if (!project?.link?.repo) {
    throw new Error(
      `timed out waiting for the Vercel project "${a.projectName}". Finish the browser deploy, then re-run, ` +
        `or set the env vars + redeploy in the Vercel dashboard.`,
    );
  }

  a.log('setting environment variables + redeploying…');
  await upsertProjectEnv(a.token, a.teamId, project.id, envVars(a.env));
  const dep = await createGitDeployment(a.token, a.teamId, {
    name: a.projectName,
    projectId: project.id,
    owner: project.link.org ?? ownerOf(a.repo),
    repo: project.link.repo,
    ref: a.ref,
  });
  await pollDeployment(a.token, a.teamId, dep.id, a.log);
  const alias = (await getProductionAlias(a.token, a.teamId, project.id)) ?? dep.url ?? null;
  if (!alias) throw new Error('redeploy is ready but no production URL was found');
  return { url: alias.startsWith('http') ? alias : `https://${alias}` };
}

export async function deployControlPlaneToVercel(opts: VercelDeployOptions): Promise<{ url: string }> {
  const auth = await resolveVercelApiAuth();
  if (!auth) {
    throw new Error('not logged in to Vercel — run `agentbox vercel login` (or set VERCEL_TOKEN)');
  }
  const { token, teamId } = auth;
  const projectName = opts.project ?? PROJECT_DEFAULT;
  const [owner, repoName] = opts.repo.split('/');
  if (!owner || !repoName) throw new Error(`--repo must be "owner/name" (got "${opts.repo}")`);

  // Resolve the deploy target: if `gh` is available and the deployer doesn't own
  // the repo, fork it to their account (Vercel can only connect a repo whose
  // owner has the Vercel GitHub App). Without `gh`, deploy the repo as-is — the
  // API connect will fail for a non-owned repo and we fall through to the button.
  let target = opts.repo;
  if (await ghAvailable()) {
    const login = await ghLogin();
    if (login && login.toLowerCase() !== owner.toLowerCase()) {
      target = await ensureFork(opts.repo, login, opts.log);
    }
  }

  const args: DeployArgs = { token, teamId, repo: target, ref: opts.ref, env: opts.env, projectName, log: opts.log };
  try {
    return await apiDeploy(args);
  } catch (e) {
    if (e instanceof GitConnectError) {
      opts.log(`Vercel can't connect ${target} via the API (GitHub App not installed); using the Deploy Button…`);
      return buttonDeploy(args);
    }
    throw e;
  }
}
