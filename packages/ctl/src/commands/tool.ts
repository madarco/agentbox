import { Command } from 'commander';
import { postRpcAndExit, postRpcAwait } from '../relay-rpc.js';
import { syncToolLinks } from '../tool-links.js';
import { parseToolNames } from '../tool-links-watcher.js';

/**
 * In-box surface for host tools — the CLIs the host has granted this box,
 * reached through the relay so the host runs them with its own credentials
 * and the box never holds a token.
 *
 * `tool run` is what the generic shim (`~/.local/bin/<name>`, a symlink to
 * `agentbox-tool-shim`) execs, so an agent normally types the tool's real
 * name and never sees this command. `list` and `request` are the discovery
 * surface: an agent that needs something it doesn't have can ask, and the
 * host answers with an approval prompt.
 */
export const toolCommand = new Command('tool').description(
  'Host CLIs proxied through the relay (the host runs the real binary with host credentials; the box never sees a token)',
);

toolCommand
  .command('list')
  .description('List the host tools granted to this box. Never enumerates the host PATH.')
  .option('--cwd <path>', 'container path identifying which registered worktree to use')
  .action(async (opts: { cwd?: string }) => {
    const code = await postRpcAndExit(
      'tool.list',
      { path: opts.cwd ?? process.cwd() },
      { errorPrefix: 'agentbox-ctl tool list' },
    );
    process.exit(code);
  });

toolCommand
  .command('request')
  .description(
    'Ask the host to grant a CLI. Raises an approval prompt naming this box and the reason; on approval the command becomes usable immediately, no restart.',
  )
  .argument('<name>', 'command name to request (e.g. terraform)')
  .option('--reason <text>', 'why the agent needs it; shown to the human in the prompt')
  .option('--cwd <path>', 'container path identifying which registered worktree to use')
  .action(async (name: string, opts: { reason?: string; cwd?: string }) => {
    const params: Record<string, unknown> = { path: opts.cwd ?? process.cwd(), name };
    if (opts.reason) params['reason'] = opts.reason;
    const code = await postRpcAndExit('tool.request', params, {
      errorPrefix: `agentbox-ctl tool request ${name}`,
    });
    // Materialize the new shim right here rather than waiting for the
    // daemon's reconcile tick — an approval the agent just waited on should
    // leave the command usable on the very next line, not up to a minute
    // later. The daemon poll stays as the slow reconciler for grants changed
    // out-of-band (`agentbox tools add/rm` on the host).
    if (code === 0) await refreshToolLinks(opts.cwd ?? process.cwd());
    process.exit(code);
  });

toolCommand
  .command('run')
  .description('Run a granted host tool. This is what the per-tool shim symlink execs.')
  .argument('<name>', 'granted tool name')
  .argument('[args...]', 'argv forwarded to the host binary verbatim')
  .option('--cwd <path>', 'container path identifying which registered worktree to use')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (name: string, args: string[], opts: { cwd?: string }) => {
    const params: Record<string, unknown> = { path: opts.cwd ?? process.cwd(), name };
    if (args.length > 0) params['args'] = args;
    const code = await postRpcAndExit('tool.run', params, { errorPrefix: name });
    process.exit(code);
  });

/** Best-effort: pull the current grant list and re-link. Never throws. */
async function refreshToolLinks(cwd: string): Promise<void> {
  try {
    const res = await postRpcAwait(
      'tool.list',
      { path: cwd, format: 'json' },
      { errorPrefix: 'agentbox-ctl tool' },
    );
    if (res.exitCode !== 0) return;
    const names = parseToolNames(res.stdout);
    // Additive: this process only needs to ADD what was just granted.
    // Pruning is the reconciler's job, and doing it here from a list that
    // races the daemon's would be the same bug from the other side.
    if (names) await syncToolLinks(names, { prunable: [] });
  } catch {
    // The daemon's reconcile tick will pick it up.
  }
}
