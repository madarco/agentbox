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
  .description('GitHub repo operations via the host `gh` CLI (host runs `gh repo …` then ships results to the box)')
  .addCommand(
    new Command('clone')
      .description(
        "Clone a github repo into the box via host `gh repo clone`. The host clones into a tmpdir with its creds, bundles, and ships the bundle back; the box materialises the working copy and resets origin to the original URL.",
      )
      .option('--cwd <path>', 'container path identifying which registered worktree to use (default: cwd)')
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

interface RunSubcommandSpec {
  op: 'list' | 'view' | 'rerun';
  description: string;
}

/**
 * `gh run` subcommands exposed via the relay. Each maps to RPC method
 * `gh.run.<op>`; the relay validates the op server-side (`GH_RUN_OPS`).
 * `list` / `view` are read-only (no prompt); `rerun` re-triggers CI and is
 * gated by the host confirm prompt. `watch` is deliberately not proxied.
 */
const RUN_SUBCOMMANDS: RunSubcommandSpec[] = [
  { op: 'list', description: 'Run `gh run list` on the host (read-only; no prompt).' },
  { op: 'view', description: 'Run `gh run view` on the host (read-only; no prompt).' },
  {
    op: 'rerun',
    description: 'Run `gh run rerun` on the host (prompted; re-triggers CI).',
  },
];

interface GhRunRpcParams {
  path: string;
  args?: string[];
}

/** Builds the `run` Command with all subcommands wired to `gh.run.<op>` RPCs. */
function buildRunCommand(errorPrefix: string): Command {
  const runCommand = new Command('run').description(
    'GitHub Actions run operations via the host `gh` CLI (requires `gh` installed and `gh auth login` on the host)',
  );
  for (const spec of RUN_SUBCOMMANDS) {
    runCommand.addCommand(
      new Command(spec.op)
        .description(spec.description)
        .option('--cwd <path>', 'container path identifying which registered worktree to use')
        .allowExcessArguments(true)
        .allowUnknownOption(true)
        .argument(
          '[args...]',
          'extra flags forwarded to `gh run <op>` verbatim (e.g. `--json`, `--limit`, `<run-id>`).',
        )
        .action(async (args: string[], opts: { cwd?: string }) => {
          const params: GhRunRpcParams = { path: opts.cwd ?? process.cwd() };
          if (args.length > 0) params.args = args;
          const code = await postRpcAndExit(`gh.run.${spec.op}`, params, { errorPrefix });
          process.exit(code);
        }),
    );
  }
  return runCommand;
}

interface GhApiRpcParams {
  path: string;
  endpoint: string;
  args?: string[];
}

const apiCommand = new Command('api')
  .description(
    'Allowlisted `gh api` (host runs `gh api`): GET on proxied endpoints, plus POST to add a PR review comment. Other methods are rejected.',
  )
  .option('--cwd <path>', 'container path identifying which registered worktree to use')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .argument('<endpoint>', 'REST endpoint, e.g. repos/:owner/:repo/pulls/:number/comments')
  .argument('[args...]', 'extra flags forwarded to `gh api` verbatim (e.g. `--jq`, `-f body=…`).')
  .action(async (endpoint: string, args: string[], opts: { cwd?: string }) => {
    const params: GhApiRpcParams = { path: opts.cwd ?? process.cwd(), endpoint };
    if (args.length > 0) params.args = args;
    const code = await postRpcAndExit('gh.api', params, { errorPrefix: 'agentbox-ctl gh api' });
    process.exit(code);
  });

export const ghCommand = new Command('gh')
  .description('GitHub CLI operations routed through the relay (host `gh` runs with host creds; box never sees a token)')
  .addCommand(buildPrCommand('agentbox-ctl gh pr'))
  .addCommand(buildRunCommand('agentbox-ctl gh run'))
  .addCommand(apiCommand)
  .addCommand(repoCommand);
