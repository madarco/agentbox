import { confirm, isCancel, log } from '@clack/prompts';
import { pruneOrphanProjectConfigs } from '@agentbox/config';
import { listBoxes, pruneBoxes, type PruneResult } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { handleLifecycleError } from './_errors.js';

interface PruneOptions {
  dryRun?: boolean;
  all?: boolean;
  yes?: boolean;
}

function totalRemovals(r: PruneResult, projectConfigs: string[]): number {
  return (
    r.removedRecords.length +
    r.removedContainers.length +
    r.removedVolumes.length +
    r.removedSnapshotDirs.length +
    r.removedBoxDirs.length +
    projectConfigs.length
  );
}

function summary(r: PruneResult, projectConfigs: string[]): string {
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
  if (projectConfigs.length > 0) {
    lines.push(
      `  project configs (${String(projectConfigs.length)}): ${projectConfigs.join(', ')}`,
    );
  }
  return lines.length > 0 ? lines.join('\n') : '  (nothing to remove)';
}

/** Project roots of boxes still in state.json — their config must survive. */
async function liveProjectRoots(): Promise<string[]> {
  try {
    const boxes = await listBoxes();
    return boxes.map((b) => b.projectRoot).filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

export const pruneCommand = new Command('prune')
  .description('Clean up orphan state.json records (and with --all, orphan docker resources)')
  .option('--dry-run', "show what would be removed, don't change anything")
  .option(
    '--all',
    'also remove orphan agentbox-* containers, volumes, snapshot dirs, and orphan per-project config dirs',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (opts: PruneOptions) => {
    try {
      const dryRun = opts.dryRun ?? false;
      // Project-config GC is part of the destructive `--all` tier (it removes
      // ~/.agentbox/projects/<hash>/ dirs whose workspace folder was deleted).
      const protectedPaths = opts.all ? await liveProjectRoots() : [];

      const preview = await pruneBoxes({ dryRun: true, all: opts.all });
      const previewProjects = opts.all
        ? (await pruneOrphanProjectConfigs({ dryRun: true, protectedPaths })).removed.map(
            (r) => r.originalPath,
          )
        : [];
      if (totalRemovals(preview, previewProjects) === 0) {
        process.stdout.write('nothing to prune\n');
        return;
      }

      log.info(`would remove:\n${summary(preview, previewProjects)}`);
      if (dryRun) return;

      if (!opts.yes) {
        const ok = await confirm({ message: 'Proceed with prune?', initialValue: true });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }

      const result = await pruneBoxes({ all: opts.all });
      const removedProjects = opts.all
        ? (await pruneOrphanProjectConfigs({ protectedPaths })).removed.map((r) => r.originalPath)
        : [];
      process.stdout.write(`pruned:\n${summary(result, removedProjects)}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
