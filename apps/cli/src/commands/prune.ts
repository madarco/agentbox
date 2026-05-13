import { confirm, isCancel, log } from '@clack/prompts';
import { pruneBoxes, type PruneResult } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { handleLifecycleError } from './_errors.js';

interface PruneOptions {
  dryRun?: boolean;
  all?: boolean;
  yes?: boolean;
}

function totalRemovals(r: PruneResult): number {
  return (
    r.removedRecords.length +
    r.removedContainers.length +
    r.removedVolumes.length +
    r.removedSnapshotDirs.length +
    r.removedBoxDirs.length
  );
}

function summary(r: PruneResult): string {
  const lines: string[] = [];
  if (r.removedRecords.length > 0) {
    lines.push(
      `  state records (${String(r.removedRecords.length)}): ${r.removedRecords.join(', ')}`,
    );
  }
  if (r.removedContainers.length > 0) {
    lines.push(
      `  containers    (${String(r.removedContainers.length)}): ${r.removedContainers.join(', ')}`,
    );
  }
  if (r.removedVolumes.length > 0) {
    lines.push(
      `  volumes       (${String(r.removedVolumes.length)}): ${r.removedVolumes.join(', ')}`,
    );
  }
  if (r.removedSnapshotDirs.length > 0) {
    lines.push(
      `  snapshot dirs (${String(r.removedSnapshotDirs.length)}): ${r.removedSnapshotDirs.join(', ')}`,
    );
  }
  if (r.removedBoxDirs.length > 0) {
    lines.push(
      `  box dirs      (${String(r.removedBoxDirs.length)}): ${r.removedBoxDirs.join(', ')}`,
    );
  }
  return lines.length > 0 ? lines.join('\n') : '  (nothing to remove)';
}

export const pruneCommand = new Command('prune')
  .description('Clean up orphan state.json records (and with --all, orphan docker resources)')
  .option('--dry-run', "show what would be removed, don't change anything")
  .option('--all', 'also remove orphan agentbox-* containers, volumes, and snapshot dirs')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (opts: PruneOptions) => {
    try {
      const dryRun = opts.dryRun ?? false;

      const preview = await pruneBoxes({ dryRun: true, all: opts.all });
      if (totalRemovals(preview) === 0) {
        process.stdout.write('nothing to prune\n');
        return;
      }

      log.info(`would remove:\n${summary(preview)}`);
      if (dryRun) return;

      if (!opts.yes) {
        const ok = await confirm({ message: 'Proceed with prune?', initialValue: true });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }

      const result = await pruneBoxes({ all: opts.all });
      process.stdout.write(`pruned:\n${summary(result)}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
