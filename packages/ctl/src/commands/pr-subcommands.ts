import { Command, Option } from 'commander';
import { postRpcAndExit } from '../relay-rpc.js';

export interface PrSubcommandSpec {
  op:
    | 'create'
    | 'view'
    | 'list'
    | 'diff'
    | 'checks'
    | 'comment'
    | 'review'
    | 'merge'
    | 'checkout'
    | 'close'
    | 'reopen';
  description: string;
}

/**
 * `gh pr` subcommands surfaced as named commands, for discoverability and
 * for the host CLI's `agentbox git pr <op>`. All of them post the same
 * `gh.exec` RPC the shim uses — this is a nicer front door, not a separate
 * capability.
 *
 * Gating lives host-side (`@agentbox/relay/src/gh.ts`): a small blocklist, a
 * short list of destructive ops that always confirm, and allow-once for
 * everything else. `checkout` additionally needs
 * `AGENTBOX_GH_PR_CHECKOUT=allow` because it moves the HOST's working tree.
 */
export const PR_SUBCOMMANDS: PrSubcommandSpec[] = [
  {
    op: 'create',
    description: "Run `gh pr create` on the host (creates a PR for this box's branch).",
  },
  { op: 'view', description: 'Run `gh pr view` on the host.' },
  { op: 'list', description: 'Run `gh pr list` on the host.' },
  { op: 'diff', description: 'Run `gh pr diff` on the host.' },
  { op: 'checks', description: 'Run `gh pr checks` on the host.' },
  { op: 'comment', description: 'Run `gh pr comment` on the host (visible to others).' },
  { op: 'review', description: 'Run `gh pr review` on the host (visible to others).' },
  {
    op: 'merge',
    description: 'Run `gh pr merge` on the host.',
  },
  {
    op: 'checkout',
    description:
      'Run `gh pr checkout` on the host (clean-tree guard; opt-in via AGENTBOX_GH_PR_CHECKOUT=allow because it switches the HOST repo branch).',
  },
  { op: 'close', description: 'Run `gh pr close` on the host.' },
  { op: 'reopen', description: 'Run `gh pr reopen` on the host.' },
];

interface PrCommonOptions {
  cwd?: string;
  /** Set by the host CLI; carries a one-time token the relay validates. */
  hostInitiatedToken?: string;
}

interface GhExecRpcParams {
  path: string;
  args?: string[];
  hostInitiated?: string;
}

/**
 * Builds the `pr` Command with all subcommands wired to the `gh.exec` RPC.
 * Used by both `agentbox-ctl git pr` and `agentbox-ctl gh pr` so the two
 * surfaces stay byte-for-byte identical.
 */
export function buildPrCommand(errorPrefix: string): Command {
  const prCommand = new Command('pr').description(
    'PR operations via the host `gh` CLI (requires `gh` installed and `gh auth login` on the host)',
  );
  for (const spec of PR_SUBCOMMANDS) {
    prCommand.addCommand(
      new Command(spec.op)
        .description(spec.description)
        .option('--cwd <path>', 'container path identifying which registered worktree to use')
        .addOption(
          new Option(
            '--host-initiated-token <token>',
            'internal: one-time token from the host CLI; skips relay confirm prompt when valid',
          ).hideHelp(),
        )
        .allowExcessArguments(true)
        .allowUnknownOption(true)
        .argument(
          '[args...]',
          'extra flags forwarded to `gh pr <op>` verbatim (e.g. `--title`, `--body`, `--label`, `--draft`, `--json`).',
        )
        .action(async (args: string[], opts: PrCommonOptions) => {
          const params: GhExecRpcParams = {
            path: opts.cwd ?? process.cwd(),
            args: ['pr', spec.op, ...args],
          };
          if (opts.hostInitiatedToken) params.hostInitiated = opts.hostInitiatedToken;
          const code = await postRpcAndExit('gh.exec', params, { errorPrefix });
          process.exit(code);
        }),
    );
  }
  return prCommand;
}
