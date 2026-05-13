import { log } from '@clack/prompts';
import { openBoxInFinder } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { handleLifecycleError } from './_errors.js';

interface OpenOpts {
  upper?: boolean;
  refresh: boolean; // commander gives `--no-refresh` => refresh=false
  includeNodeModules?: boolean;
  print?: boolean;
}

export const openCommand = new Command('open')
  .description("Open a box's merged workspace in Finder (snapshot of the agent's view)")
  .argument('<box>', 'box id, id prefix, name, or container name')
  .option('--upper', 'open just the writes layer (live on OrbStack, snapshot on Docker Desktop)')
  .option('--no-refresh', "skip the rsync; open whatever's already on disk")
  .option(
    '--include-node-modules',
    'include /workspace/node_modules in the merged export (off by default)',
  )
  .option(
    '--print',
    'print the host path instead of launching Finder (still refreshes; combine with --no-refresh to skip)',
  )
  .action(async (idOrName: string, opts: OpenOpts) => {
    try {
      const layer = opts.upper ? 'upper' : 'merged';
      const result = await openBoxInFinder(idOrName, {
        layer,
        includeNodeModules: opts.includeNodeModules,
        noRefresh: !opts.refresh,
        noOpen: !!opts.print,
      });

      if (opts.print) {
        process.stdout.write(`${result.hostPath}\n`);
      } else {
        const liveNote = !result.copied ? ' (live)' : result.usedFallback ? ' (tar fallback)' : '';
        process.stdout.write(`opened ${result.hostPath}${liveNote}\n`);
      }

      if (opts.upper && result.engine !== 'orbstack' && result.copied && !opts.print) {
        log.info('Tip: live upper-layer browsing requires OrbStack. Re-run `agentbox open --upper` to refresh.');
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
