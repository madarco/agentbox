import { Command } from 'commander';
import { postRpcAndExit } from '../relay-rpc.js';
import { buildPrCommand } from './pr-subcommands.js';

interface GhRepoCloneRpcParams {
  path: string;
  repo: string;
  targetPath?: string;
  args?: string[];
}

const repoCommand = new Command('repo')
  .description(
    'GitHub repo operations via the host `gh` CLI (host runs `gh repo …` then ships results to the box)',
  )
  .addCommand(
    new Command('clone')
      .description(
        'Clone a github repo into the box via host `gh repo clone`. The host clones into a tmpdir with its creds, bundles, and ships the bundle back; the box materialises the working copy and resets origin to the original URL.',
      )
      .option(
        '--cwd <path>',
        'container path identifying which registered worktree to use (default: cwd)',
      )
      .option('--branch <name>', 'pass --branch <name> to host gh repo clone')
      .option('--depth <n>', 'pass --depth <n> to host gh repo clone')
      .argument('<repo>', 'github repo: owner/name shorthand or full URL')
      .argument('[dir]', 'target directory inside the box (default: derived from repo)')
      .action(
        async (
          repo: string,
          dir: string | undefined,
          opts: { cwd?: string; branch?: string; depth?: string },
        ) => {
          const params: GhRepoCloneRpcParams = {
            path: opts.cwd ?? process.cwd(),
            repo,
          };
          if (dir) params.targetPath = dir;
          const extra: string[] = [];
          if (opts.branch) extra.push('--branch', opts.branch);
          if (opts.depth) extra.push('--depth', opts.depth);
          if (extra.length > 0) params.args = extra;
          const code = await postRpcAndExit('gh.repo.clone', params, {
            errorPrefix: 'agentbox-ctl gh repo clone',
          });
          process.exit(code);
        },
      ),
  );

interface GhExecRpcParams {
  path: string;
  args?: string[];
}

/**
 * `agentbox-ctl gh exec -- <argv...>` — the whole GitHub CLI, forwarded to the
 * host's authenticated `gh`. This is what the in-box `gh` shim execs, and it
 * replaced the old per-subcommand surface (`gh run <op>`, `gh api <endpoint>`)
 * that could only proxy what it had been taught.
 *
 * Gating is host-side: a small blocklist, a short list of destructive ops that
 * always confirm, and allow-once for everything else.
 */
const execCommand = new Command('exec')
  .description('Run the host `gh` with these arguments (the box never sees a GitHub token)')
  .option('--cwd <path>', 'container path identifying which registered worktree to use')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .argument('[args...]', 'gh argv, forwarded verbatim (e.g. `issue list --state open`)')
  .action(async (args: string[], opts: { cwd?: string }) => {
    const params: GhExecRpcParams = { path: opts.cwd ?? process.cwd() };
    if (args.length > 0) params.args = args;
    const code = await postRpcAndExit('gh.exec', params, {
      errorPrefix: args[0] ? `agentbox-ctl gh ${args[0]}` : 'agentbox-ctl gh',
    });
    process.exit(code);
  });

export const ghCommand = new Command('gh')
  .description(
    'GitHub CLI operations routed through the relay (host `gh` runs with host creds; box never sees a token)',
  )
  .addCommand(execCommand)
  .addCommand(buildPrCommand('agentbox-ctl gh pr'))
  .addCommand(repoCommand);
