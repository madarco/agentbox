import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { postRpcAndExit } from '../relay-rpc.js';

interface CommonOptions {
  remote?: string;
  cwd?: string;
}

interface GitRpcParams {
  path: string;
  remote?: string;
  args?: string[];
}

function buildParams(opts: CommonOptions, extra: string[]): GitRpcParams {
  const params: GitRpcParams = { path: opts.cwd ?? process.cwd() };
  if (opts.remote) params.remote = opts.remote;
  if (extra.length > 0) params.args = extra;
  return params;
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
      .description("Run `git push` on the host main repo against this box's branch (user is prompted on the host wrapper to confirm)")
      .option('--remote <name>', 'remote name (default: origin)')
      .option('--cwd <path>', 'container path identifying which registered worktree to use')
      .allowExcessArguments(true)
      .allowUnknownOption(true)
      .argument(
        '[args...]',
        "extra flags appended to the host-built `git push <remote> <branch>` (e.g. `--force-with-lease`, `--tags`). Do NOT re-pass the remote or branch — they are taken from --remote and the registered worktree; appending them as positionals makes git treat them as refspecs and fail with `refs/remotes/origin/HEAD cannot be resolved to branch`. Use --remote to change the remote.",
      )
      .action(async (args: string[], opts: CommonOptions) => {
        const code = await postRpcAndExit('git.push', buildParams(opts, args), {
          errorPrefix: 'agentbox-ctl git',
        });
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
      .argument(
        '[args...]',
        'extra flags appended to the host-built `git fetch <remote> <branch>` (e.g. `--prune`, `--tags`). Do NOT re-pass the remote or branch; they come from --remote and the registered worktree (same gotcha as `push`).',
      )
      .action(async (args: string[], opts: CommonOptions) => {
        const code = await postRpcAndExit('git.fetch', buildParams(opts, args), {
          errorPrefix: 'agentbox-ctl git',
        });
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
      .argument(
        '[args...]',
        'extra flags appended to the host-built `git fetch <remote> <branch>` (e.g. `--prune`). Do NOT re-pass the remote or branch; they come from --remote and the registered worktree (same gotcha as `push`).',
      )
      .action(
        async (
          args: string[],
          opts: CommonOptions & { ffOnly?: boolean },
        ) => {
          const fetchCode = await postRpcAndExit('git.fetch', buildParams(opts, args), {
            errorPrefix: 'agentbox-ctl git',
          });
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
