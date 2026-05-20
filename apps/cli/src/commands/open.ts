import { openBoxInFinder } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { runPath } from './path.js';
import { handleLifecycleError } from './_errors.js';

interface OpenOpts {
  refresh: boolean; // commander gives `--no-refresh` => refresh=false
  includeNodeModules?: boolean;
  print?: boolean;
  path?: boolean;
}

export const openCommand = new Command('open')
  .description("Open a box's /workspace in Finder (rsync'd snapshot of the agent's view)")
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--no-refresh', "skip the rsync; open whatever's already on disk")
  .option(
    '--include-node-modules',
    'include /workspace/node_modules in the merged export (off by default)',
  )
  .option('--path', 'print the host workspace path instead of launching Finder')
  .option('--print', 'alias of --path')
  .action(async (idOrName: string | undefined, opts: OpenOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      if (opts.path || opts.print) {
        await runPath(box, {
          refresh: opts.refresh, // print refreshes by default; --no-refresh skips
          includeNodeModules: opts.includeNodeModules,
        });
        return;
      }

      const result = await openBoxInFinder(box.id, {
        includeNodeModules: opts.includeNodeModules,
        noRefresh: !opts.refresh,
        noOpen: false,
      });

      const liveNote = !result.copied ? ' (live)' : result.usedFallback ? ' (tar fallback)' : '';
      process.stdout.write(`opened ${result.hostPath}${liveNote}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
