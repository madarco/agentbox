import { getBoxHostPaths, refreshExport } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface PathOpts {
  upper?: boolean;
  refresh?: boolean;
  includeNodeModules?: boolean;
}

export const pathCommand = new Command('path')
  .description("Print the host path to a box's workspace export (--refresh to rsync first)")
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--upper', 'print the path to the writes layer instead of the merged view')
  .option('--refresh', 'rsync the export before printing (off by default)')
  .option(
    '--include-node-modules',
    'include /workspace/node_modules when refreshing the merged export',
  )
  .action(async (idOrName: string | undefined, opts: PathOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const layer = opts.upper ? 'upper' : 'merged';
      const { record, paths } = await getBoxHostPaths(box.id);

      if (opts.refresh) {
        const refreshed = await refreshExport(record, {
          layer,
          includeNodeModules: opts.includeNodeModules,
        });
        process.stdout.write(`${refreshed.hostPath}\n`);
        return;
      }

      const path =
        layer === 'upper' ? (paths.upperLiveOnHost ?? paths.upperExport) : paths.mergedExport;
      process.stdout.write(`${path}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
