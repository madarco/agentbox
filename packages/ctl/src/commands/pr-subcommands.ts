import { Command, Option } from 'commander';
import { postRpcAndExit } from '../relay-rpc.js';

export interface PrSubcommandSpec {
  op: 'create' | 'view' | 'list' | 'comment' | 'review' | 'merge' | 'checkout' | 'close' | 'reopen';
  description: string;
}

/**
 * `gh pr` subcommands exposed via the relay. Each maps to RPC method
 * `gh.pr.<op>`. The relay validates the op server-side (must match `GH_PR_OPS`
 * in `@agentbox/relay/src/gh.ts`).
 *
 * Confirmation matrix lives host-side:
 *   - `view`, `list` → read-only, no prompt.
 *   - `create`, `comment`, `review`, `close`, `reopen` → prompt.
 *   - `merge` → prompt; AGENTBOX_PROMPT=off bypass requires AGENTBOX_GH_FORCE=1.
 *   - `checkout` → prompt + dirty-tree guard + opt-in (AGENTBOX_GH_PR_CHECKOUT=allow).
 */
export const PR_SUBCOMMANDS: PrSubcommandSpec[] = [
  {
    op: 'create',
    description:
      'Run `gh pr create` on the host (creates a PR for this box\'s branch). User is prompted on the host wrapper.',
  },
  { op: 'view', description: 'Run `gh pr view` on the host (read-only; no prompt).' },
  { op: 'list', description: 'Run `gh pr list` on the host (read-only; no prompt).' },
  { op: 'comment', description: 'Run `gh pr comment` on the host (prompted; visible to others).' },
  { op: 'review', description: 'Run `gh pr review` on the host (prompted; visible to others).' },
  {
    op: 'merge',
    description:
      'Run `gh pr merge` on the host (prompted; destructive — AGENTBOX_PROMPT=off bypass requires AGENTBOX_GH_FORCE=1).',
  },
  {
    op: 'checkout',
    description:
      'Run `gh pr checkout` on the host (prompted + clean-tree guard; opt-in via AGENTBOX_GH_PR_CHECKOUT=allow because it switches the host main repo branch).',
  },
  { op: 'close', description: 'Run `gh pr close` on the host (prompted).' },
  { op: 'reopen', description: 'Run `gh pr reopen` on the host (prompted).' },
];

interface PrCommonOptions {
  cwd?: string;
  /** Set by the host CLI; carries a one-time token the relay validates. */
  hostInitiatedToken?: string;
}

interface GhPrRpcParams {
  path: string;
  args?: string[];
  hostInitiated?: string;
}

/**
 * Builds the `pr` Command with all subcommands wired to `gh.pr.<op>` RPCs.
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
          const params: GhPrRpcParams = { path: opts.cwd ?? process.cwd() };
          if (args.length > 0) params.args = args;
          if (opts.hostInitiatedToken) params.hostInitiated = opts.hostInitiatedToken;
          const code = await postRpcAndExit(`gh.pr.${spec.op}`, params, { errorPrefix });
          process.exit(code);
        }),
    );
  }
  return prCommand;
}
