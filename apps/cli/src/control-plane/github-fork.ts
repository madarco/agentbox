import { spawn } from 'node:child_process';

/**
 * Thin `gh` CLI wrappers for the Vercel deploy's auto-fork step. Vercel can only
 * connect a repo whose owner has the Vercel GitHub App, so a deployer who
 * doesn't own the target repo forks it to their own account first. `gh` is a
 * host tool (same as the relay's `gh pr` path) — absent/unauthed routes the
 * caller to the Deploy-Button fallback instead.
 */
function gh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: 127, stdout: '', stderr: 'gh not found' });
      return;
    }
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', () => resolve({ code: 127, stdout, stderr: stderr || 'gh not found' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function ownerOf(repo: string): string {
  return repo.split('/')[0] ?? '';
}
export function nameOf(repo: string): string {
  return repo.split('/')[1] ?? '';
}

/** Whether `gh` is installed AND authenticated. */
export async function ghAvailable(): Promise<boolean> {
  return (await gh(['auth', 'status'])).code === 0;
}

/** The authenticated GitHub login, or null. */
export async function ghLogin(): Promise<string | null> {
  const r = await gh(['api', 'user', '-q', '.login']);
  const login = r.stdout.trim();
  return r.code === 0 && login.length > 0 ? login : null;
}

/**
 * Fork `repo` to the authenticated user (idempotent — tolerates an existing
 * fork) and wait until the GitHub API sees it. Returns `<login>/<name>`.
 */
export async function ensureFork(repo: string, login: string, log: (l: string) => void): Promise<string> {
  const fork = `${login}/${nameOf(repo)}`;
  log(`forking ${repo} -> ${fork}…`);
  const f = await gh(['repo', 'fork', repo, '--clone=false']);
  if (f.code !== 0 && !/already exists/i.test(`${f.stderr}${f.stdout}`)) {
    throw new Error(`gh repo fork ${repo} failed: ${(f.stderr || f.stdout).trim()}`);
  }
  // Forks are created asynchronously — poll until the API resolves the fork.
  const stop = Date.now() + 60_000;
  while (Date.now() < stop) {
    const v = await gh(['api', `repos/${fork}`, '-q', '.full_name']);
    if (v.code === 0 && v.stdout.trim().toLowerCase() === fork.toLowerCase()) return fork;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`fork ${fork} did not become available within 60s`);
}
