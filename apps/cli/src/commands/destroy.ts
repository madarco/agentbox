import { confirm, isCancel, log } from '@clack/prompts';
import { destroyBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface DestroyOptions {
  yes?: boolean;
  keepSnapshot?: boolean;
}

export const destroyCommand = new Command('destroy')
  .alias('rm')
  .description('Destroy a box and discard its upper volume')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--keep-snapshot', "don't delete the snapshot dir under ~/.agentbox/snapshots/")
  .action(async (idOrName: string | undefined, opts: DestroyOptions) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      if (!opts.yes) {
        log.warn(`This will discard the upper volume — agent work-in-progress is lost.`);
        log.info(`id:        ${box.id}`);
        log.info(`container: ${box.container}`);
        log.info(`upper:     ${box.upperVolume}`);
        if (box.snapshotDir) {
          log.info(`snapshot:  ${box.snapshotDir}${opts.keepSnapshot ? ' (will be kept)' : ''}`);
        }
        const ok = await confirm({
          message: 'Destroy this box?',
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }

      const result = await destroyBox(box.id, { keepSnapshot: opts.keepSnapshot });
      const out: string[] = [`destroyed ${result.record.container}`];
      if (result.removedContainer) out.push('  ✓ container removed');
      out.push(`  ✓ volumes removed: ${result.removedVolumes.join(', ')}`);
      if (result.removedSnapshot) out.push(`  ✓ snapshot removed: ${result.removedSnapshot}`);
      else if (box.snapshotDir && opts.keepSnapshot) {
        out.push(`  · snapshot kept: ${box.snapshotDir}`);
      }
      process.stdout.write(out.join('\n') + '\n');
    } catch (err) {
      handleLifecycleError(err);
    }
  });
