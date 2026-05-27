import { Command, Option } from 'commander';
import { spawn } from 'node:child_process';
import { postRpcAndExit } from '../relay-rpc.js';
import { buildPrCommand } from './pr-subcommands.js';

/**
 * Hidden CLI flag carrying a one-time scoped token minted by the host CLI
 * via the relay's loopback-only `/admin/host-initiated/mint`. The relay
 * validates the token + (boxId, method) scope on the receiving RPC and
 * skips its confirm prompt on match. We use a CLI arg (not an env var)
 * because env vars are inherited by child processes — a `git push`
 * pre-push hook (or any other in-box command agentbox-ctl spawns) would
 * inherit the token and could replay it. The CLI arg lives only on the
 * agentbox-ctl process itself.
 */
function hostInitiatedOption(): Option {
  return new Option(
    '--host-initiated-token <token>',
    'internal: one-time token from the host CLI; skips relay confirm prompt when valid',
  ).hideHelp();
}

interface CommonOptions {
  remote?: string;
  cwd?: string;
  /** Set by the host CLI; carries a one-time token the relay validates. */
  hostInitiatedToken?: string;
}

interface GitRpcParams {
  path: string;
  remote?: string;
  args?: string[];
  hostInitiated?: string;
}

interface GitCloneRpcParams {
  path: string;
  url: string;
  targetPath?: string;
  args?: string[];
}

function buildParams(opts: CommonOptions, extra: string[]): GitRpcParams {
  const params: GitRpcParams = { path: opts.cwd ?? process.cwd() };
  if (opts.remote) params.remote = opts.remote;
  if (extra.length > 0) params.args = extra;
  if (opts.hostInitiatedToken) params.hostInitiated = opts.hostInitiatedToken;
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
      .addOption(hostInitiatedOption())
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
      .addOption(hostInitiatedOption())
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
      .addOption(hostInitiatedOption())
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
  )
  .addCommand(
    new Command('clone')
      .description(
        "Clone a github repo into the box. Host runs `git clone` with its creds into a tmpdir, bundles, and ships the bundle back; the box materialises the working copy and resets origin to the original URL.",
      )
      .option('--cwd <path>', 'container path identifying which registered worktree to use (default: cwd)')
      .option('--branch <name>', 'pass --branch <name> to host git clone')
      .option('--depth <n>', 'pass --depth <n> to host git clone')
      .argument('<url>', 'github URL or owner/name shorthand')
      .argument('[dir]', 'target directory inside the box (default: derived from url)')
      .action(
        async (
          url: string,
          dir: string | undefined,
          opts: { cwd?: string; branch?: string; depth?: string },
        ) => {
          const params: GitCloneRpcParams = {
            path: opts.cwd ?? process.cwd(),
            url,
          };
          if (dir) params.targetPath = dir;
          const extra: string[] = [];
          if (opts.branch) extra.push('--branch', opts.branch);
          if (opts.depth) extra.push('--depth', opts.depth);
          if (extra.length > 0) params.args = extra;
          const code = await postRpcAndExit('git.clone', params, {
            errorPrefix: 'agentbox-ctl git clone',
          });
          process.exit(code);
        },
      ),
  )
  .addCommand(buildPrCommand('agentbox-ctl git pr'));
