import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

interface GitRpcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CommonOptions {
  remote?: string;
  cwd?: string;
}

async function rpc(
  method: 'git.push' | 'git.fetch',
  opts: CommonOptions,
  extra: string[],
): Promise<number> {
  const urlStr = process.env.AGENTBOX_RELAY_URL;
  const token = process.env.AGENTBOX_RELAY_TOKEN;
  if (!urlStr || !token) {
    process.stderr.write(
      'agentbox-ctl git: AGENTBOX_RELAY_URL / AGENTBOX_RELAY_TOKEN not set; no relay configured for this box.\n',
    );
    return 65;
  }
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    process.stderr.write(`agentbox-ctl git: invalid AGENTBOX_RELAY_URL: ${urlStr}\n`);
    return 65;
  }

  const params: Record<string, unknown> = {
    path: opts.cwd ?? process.cwd(),
  };
  if (opts.remote) params.remote = opts.remote;
  if (extra.length > 0) params.args = extra;

  const body = JSON.stringify({ method, params });
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? httpsRequest : httpRequest;
  const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;

  return new Promise<number>((resolve) => {
    const req = transport(
      {
        host: url.hostname,
        port,
        method: 'POST',
        path: `${url.pathname.replace(/\/$/, '')}/rpc`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: GitRpcResult | null = null;
          try {
            parsed = JSON.parse(text) as GitRpcResult;
          } catch {
            parsed = null;
          }
          if (parsed && typeof parsed.exitCode === 'number') {
            if (parsed.stdout) process.stdout.write(parsed.stdout);
            if (parsed.stderr) process.stderr.write(parsed.stderr);
            resolve(parsed.exitCode);
            return;
          }
          process.stderr.write(`agentbox-ctl git: relay returned ${String(status)}: ${text}\n`);
          resolve(status >= 200 && status < 300 ? 0 : 1);
        });
      },
    );
    req.on('error', (err) => {
      process.stderr.write(`agentbox-ctl git: ${String(err.message ?? err)}\n`);
      resolve(126);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Run a local `git` command inside the box, streaming output to the parent's
 * stdio. Used by `pull` for the in-container merge step (no creds needed —
 * the fetch already happened host-side via the relay).
 */
function runLocalGit(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      process.stderr.write(`agentbox-ctl git: ${String(err.message ?? err)}\n`);
      resolve(126);
    });
  });
}

export const gitCommand = new Command('git')
  .description('Git operations that need host credentials (routed through the agentbox relay)')
  .addCommand(
    new Command('push')
      .description('Run `git push` on the host main repo against this box\'s branch')
      .option('--remote <name>', 'remote name (default: origin)')
      .option('--cwd <path>', 'container path identifying which registered worktree to use')
      .allowExcessArguments(true)
      .allowUnknownOption(true)
      .argument('[args...]', 'additional args forwarded to git push')
      .action(async (args: string[], opts: CommonOptions) => {
        const code = await rpc('git.push', opts, args);
        process.exit(code);
      }),
  )
  .addCommand(
    new Command('fetch')
      .description('Run `git fetch` on the host main repo (refs land in the shared .git)')
      .option('--remote <name>', 'remote name (default: origin)')
      .option('--cwd <path>', 'container path identifying which registered worktree to use')
      .allowExcessArguments(true)
      .allowUnknownOption(true)
      .argument('[args...]', 'additional args forwarded to git fetch')
      .action(async (args: string[], opts: CommonOptions) => {
        const code = await rpc('git.fetch', opts, args);
        process.exit(code);
      }),
  )
  .addCommand(
    new Command('pull')
      .description(
        'Fetch via the relay (host creds), then merge into the in-container working tree locally',
      )
      .option('--remote <name>', 'remote name (default: origin)')
      .option('--cwd <path>', 'container path identifying which registered worktree to use')
      .option('--ff-only', 'pass --ff-only to the local merge')
      .allowExcessArguments(true)
      .allowUnknownOption(true)
      .argument('[args...]', 'additional args forwarded to git fetch')
      .action(
        async (
          args: string[],
          opts: CommonOptions & { ffOnly?: boolean },
        ) => {
          const fetchCode = await rpc('git.fetch', opts, args);
          if (fetchCode !== 0) process.exit(fetchCode);
          // Merge happens in the container, where the working tree lives. No
          // creds needed; refs are already in the shared .git from the fetch.
          const remote = opts.remote ?? 'origin';
          // Resolve branch via the current HEAD's upstream, falling back to
          // `<remote>/HEAD` so a freshly cloned worktree still pulls.
          const cwd = opts.cwd ?? process.cwd();
          const mergeArgs = ['merge'];
          if (opts.ffOnly) mergeArgs.push('--ff-only');
          mergeArgs.push(`${remote}/HEAD`);
          const mergeCode = await runLocalGit(mergeArgs, cwd);
          process.exit(mergeCode);
        },
      ),
  );
