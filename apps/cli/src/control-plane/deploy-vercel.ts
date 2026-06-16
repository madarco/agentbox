import { spawn } from 'node:child_process';

/**
 * Deploy the control plane (`apps/control-plane`) to Vercel by driving the
 * logged-in `vercel` CLI: link the project, provision Neon (POSTGRES_URL),
 * push the App env, and `deploy --prod`. The caller falls back to the printed
 * manual steps if any step fails (e.g. the CLI isn't logged in).
 */
export interface VercelDeployOptions {
  /** Absolute path to apps/control-plane (the Vercel project root). */
  appDir: string;
  /** Env vars to set as production secrets (App id/key + admin token). */
  env: Record<string, string>;
  /** Vercel project name. */
  project?: string;
  log: (line: string) => void;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  opts: { cwd: string; input?: string; onLine?: (line: string) => void },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('vercel', args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      const t = c.toString('utf8');
      stdout += t;
      if (opts.onLine) for (const l of t.split(/\r?\n/)) if (l.trim()) opts.onLine(l.trim());
    });
    child.stderr.on('data', (c: Buffer) => {
      const t = c.toString('utf8');
      stderr += t;
      if (opts.onLine) for (const l of t.split(/\r?\n/)) if (l.trim()) opts.onLine(l.trim());
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

function lastVercelUrl(text: string): string | null {
  const matches = text.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/gi);
  return matches && matches.length > 0 ? matches[matches.length - 1]! : null;
}

export async function deployControlPlaneToVercel(opts: VercelDeployOptions): Promise<{ url: string }> {
  const { appDir, log } = opts;
  const project = opts.project ?? 'agentbox-control-plane';

  const version = await run(['--version'], { cwd: appDir }).catch(() => null);
  if (!version || version.code !== 0) {
    throw new Error('the `vercel` CLI is not available — install it and run `vercel login` (or `agentbox vercel login`)');
  }

  log(`linking the Vercel project "${project}"…`);
  const link = await run(['link', '--yes', '--project', project], { cwd: appDir, onLine: log });
  if (link.code !== 0) {
    throw new Error(`vercel link failed — is the CLI logged in? (\`vercel login\`)\n${link.stderr || link.stdout}`);
  }

  log('provisioning Neon Postgres (vercel integration add neon)…');
  const neon = await run(['integration', 'add', 'neon', '--non-interactive'], { cwd: appDir, onLine: log });
  if (neon.code !== 0) {
    log('neon integration add returned non-zero — continuing (it may already be attached)');
  }

  for (const [name, value] of Object.entries(opts.env)) {
    // Replace any existing value so re-runs are idempotent.
    await run(['env', 'rm', name, 'production', '--yes'], { cwd: appDir }).catch(() => undefined);
    log(`setting ${name} (production)…`);
    const add = await run(['env', 'add', name, 'production'], { cwd: appDir, input: `${value}\n` });
    if (add.code !== 0) {
      throw new Error(`vercel env add ${name} failed:\n${add.stderr || add.stdout}`);
    }
  }

  log('deploying to production (vercel deploy --prod)…');
  const deploy = await run(['deploy', '--prod', '--yes'], { cwd: appDir, onLine: log });
  if (deploy.code !== 0) {
    throw new Error(`vercel deploy failed:\n${deploy.stderr || deploy.stdout}`);
  }
  const url = lastVercelUrl(deploy.stdout) ?? lastVercelUrl(deploy.stderr);
  if (!url) {
    throw new Error('deploy succeeded but no *.vercel.app URL was found in the output');
  }
  return { url };
}
