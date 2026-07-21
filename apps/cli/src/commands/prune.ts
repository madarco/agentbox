import { confirm, log } from '../lib/prompt.js';
import { pruneOrphanProjectConfigs } from '@agentbox/config';
import type { CloudBackend, CloudSandboxSummary } from '@agentbox/core';
import { readState } from '@agentbox/sandbox-core';
import { listBoxes, pruneBoxes, type PruneResult } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { handleLifecycleError } from './_errors.js';
import { cloudBackendForProvider } from '../provider/cloud-backend.js';

interface PruneOptions {
  dryRun?: boolean;
  all?: boolean;
  yes?: boolean;
  provider?: string;
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
  .option(
    '--provider <name>',
    'restrict prune to a specific provider (docker | daytona | hetzner | vercel | e2b | digitalocean). For cloud providers, lists sandboxes that are not in this CLI\'s state.json and offers to delete them.',
  )
  .action(async (opts: PruneOptions) => {
    try {
      if (opts.provider !== undefined && isCloudPruneProvider(opts.provider)) {
        await pruneCloud(opts.provider, opts);
        return;
      }
      if (opts.provider !== undefined && opts.provider !== 'docker') {
        log.error(`unknown provider '${opts.provider}'; expected docker, daytona, hetzner, vercel, e2b, or digitalocean`);
        process.exit(2);
      }
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
        if (!ok) {
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

/** Cloud providers whose orphan sandboxes `prune --provider <p>` can enumerate + delete. */
const CLOUD_PRUNE_PROVIDERS = [
  'daytona',
  'hetzner',
  'vercel',
  'e2b',
  'digitalocean',
  'remote-docker',
] as const;
type CloudPruneProvider = (typeof CLOUD_PRUNE_PROVIDERS)[number];

function isCloudPruneProvider(name: string): name is CloudPruneProvider {
  return (CLOUD_PRUNE_PROVIDERS as readonly string[]).includes(name);
}

/**
 * Cloud orphan-sandbox prune. Lists every sandbox the configured credentials
 * can see, cross-references against this CLI's local `state.json`, and offers
 * to delete the ones the user no longer tracks (typically: a harness timeout
 * killed the create before `recordBox` ran, leaving a half-provisioned
 * billable sandbox lingering).
 *
 * Read-only without `--yes`: prints the orphan list and confirms before
 * deleting. With `--dry-run`, only prints.
 */
async function pruneCloud(provider: CloudPruneProvider, opts: PruneOptions): Promise<void> {
  const dryRun = opts.dryRun ?? false;
  // CloudPruneProvider is always a cloud provider, so this never resolves null.
  const backend = (await cloudBackendForProvider(provider)) as CloudBackend;
  if (!backend.list) {
    log.error(`${provider} backend doesn't expose \`list()\`; cannot enumerate sandboxes for prune`);
    process.exit(2);
  }
  const [remote, state] = await Promise.all([backend.list(), readState()]);
  const knownIds = new Set<string>();
  for (const b of state.boxes) {
    if ((b.provider ?? 'docker') === provider && b.cloud?.sandboxId) {
      knownIds.add(b.cloud.sandboxId);
    }
  }
  // Anything we created (labelled by us via `tags: { 'agentbox.name': ... }`)
  // but isn't in state is an orphan we should offer to clean up. Sandboxes
  // the user provisioned through other tooling shouldn't be touched — identify
  // ours by the presence of a friendly name (`summary.name` mirrors that tag).
  const orphans: CloudSandboxSummary[] = remote.filter((sb) => {
    if (knownIds.has(sb.sandboxId)) return false;
    const friendly = sb.name ?? '';
    return friendly.length > 0;
  });
  if (orphans.length === 0) {
    process.stdout.write(`no ${provider} orphans found\n`);
    return;
  }
  log.info(`found ${String(orphans.length)} ${provider} sandbox(es) not in this CLI's state:`);
  for (const sb of orphans) {
    const parts = [sb.sandboxId];
    if (sb.name) parts.push(sb.name);
    if (sb.state) parts.push(sb.state);
    if (sb.createdAt) parts.push(sb.createdAt);
    process.stdout.write(`  ${parts.join('  ')}\n`);
  }
  if (dryRun) return;
  if (!opts.yes) {
    const ok = await confirm({
      message: `Delete ${String(orphans.length)} orphan sandbox(es)?`,
      initialValue: false,
    });
    if (!ok) {
      log.info('cancelled');
      return;
    }
  }
  let deleted = 0;
  let failed = 0;
  for (const sb of orphans) {
    try {
      await backend.destroy({ sandboxId: sb.sandboxId });
      deleted++;
    } catch (err) {
      failed++;
      log.warn(
        `delete ${sb.sandboxId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  process.stdout.write(
    `${provider} prune: deleted ${String(deleted)}, failed ${String(failed)}\n`,
  );
}
