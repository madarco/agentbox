import { confirm, log } from '../lib/prompt.js';
import { Command } from 'commander';
import { boxOwningHubIsLocal, withHubClient } from '../control-plane/with-hub.js';
import type {
  HubApiClient,
  HubApiCloudOrphan,
  HubApiPruneCloud,
  HubApiPruneGeneral,
  HubApiPruneResult,
} from '../control-plane/hub-api-client.js';
import { handleLifecycleError } from './_errors.js';
import { listProviderDescriptors, resolveProviderDescriptor } from '@agentbox/sandbox-core';

/**
 * `agentbox prune` — fleet cleanup through the hub's public `/api/v1`
 * (`POST /prune`). The hub runs `pruneBoxes` (+ orphan project configs) for the
 * general/docker tier, and for a cloud `--provider` enumerates untracked sandboxes
 * and (on confirm) deletes them AND reaps their control-box registrations
 * server-side — so this CLI no longer carries a separate reap.
 *
 * Prune is FLEET-scoped, not box-scoped, so it can't use `withOwningHub` (there is
 * no box to own it). It routes by the provider argument instead, reusing the same
 * ownership predicate: docker + remote-docker are local-owned (their engine/host
 * is driven by the LOCAL hub), so those go to the local hub; a true cloud provider
 * (daytona/hetzner/vercel/e2b/digitalocean) is owned by the configured hub.
 */

interface PruneOptions {
  dryRun?: boolean;
  all?: boolean;
  yes?: boolean;
  provider?: string;
}

function totalRemovals(r: HubApiPruneResult, projectConfigs: string[]): number {
  return (
    r.removedRecords.length +
    r.removedContainers.length +
    r.removedVolumes.length +
    r.removedSnapshotDirs.length +
    r.removedBoxDirs.length +
    projectConfigs.length
  );
}

function summary(r: HubApiPruneResult, projectConfigs: string[]): string {
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

/**
 * Whether `prune --provider <p>` can enumerate + delete this provider's orphan
 * sandboxes — i.e. whether its backend implements `list`. Read from the
 * descriptor rather than a hardcoded name list, so a community provider with a
 * listable backend is prunable too.
 */
function isCloudPruneProvider(name: string): boolean {
  return resolveProviderDescriptor(name)?.capabilities.prune ?? false;
}

/** Prunable provider names, for the `--provider` error message. */
function cloudPruneProviders(): string[] {
  return listProviderDescriptors()
    .filter((d) => d.capabilities.prune)
    .map((d) => d.name);
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
    "restrict prune to a specific provider (docker | daytona | hetzner | vercel | e2b | digitalocean). For cloud providers, lists sandboxes that are not in this CLI's state.json and offers to delete them.",
  )
  .action(async (opts: PruneOptions) => {
    try {
      const provider = opts.provider;
      if (provider !== undefined && provider !== 'docker' && !isCloudPruneProvider(provider)) {
        log.error(
          `unknown provider '${provider}'; expected docker or one of ${cloudPruneProviders().join(', ')}`,
        );
        process.exit(2);
      }
      // Fleet routing by provider: docker/remote-docker → local hub; a true cloud
      // provider → the configured hub. Reuses the box-ownership predicate so the
      // "which hub" rule is single-sourced (a general prune has no provider →
      // defaults to docker → local).
      const preferLocal = boxOwningHubIsLocal({ provider: provider ?? 'docker' });
      const isCloud = provider !== undefined && isCloudPruneProvider(provider);

      await withHubClient({ preferLocal }, async (client) => {
        if (isCloud) {
          await runCloudPrune(client, provider!, opts);
        } else {
          await runGeneralPrune(client, opts);
        }
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });

async function runGeneralPrune(client: HubApiClient, opts: PruneOptions): Promise<void> {
  const dryRun = opts.dryRun ?? false;
  const preview = (await client.prune({ all: opts.all, dryRun: true })) as HubApiPruneGeneral;
  if (totalRemovals(preview.result, preview.projectConfigs) === 0) {
    process.stdout.write('nothing to prune\n');
    return;
  }
  log.info(`would remove:\n${summary(preview.result, preview.projectConfigs)}`);
  if (dryRun) return;

  if (!opts.yes) {
    const ok = await confirm({ message: 'Proceed with prune?', initialValue: true });
    if (!ok) {
      log.info('cancelled');
      return;
    }
  }
  const done = (await client.prune({ all: opts.all })) as HubApiPruneGeneral;
  process.stdout.write(`pruned:\n${summary(done.result, done.projectConfigs)}\n`);
}

async function runCloudPrune(
  client: HubApiClient,
  provider: string,
  opts: PruneOptions,
): Promise<void> {
  const dryRun = opts.dryRun ?? false;
  const preview = (await client.prune({ provider, dryRun: true })) as HubApiPruneCloud;
  if (preview.orphans.length === 0) {
    process.stdout.write(`no ${provider} orphans found\n`);
    return;
  }
  log.info(
    `found ${String(preview.orphans.length)} ${provider} sandbox(es) not in this fleet's state:`,
  );
  for (const sb of preview.orphans) process.stdout.write(`  ${orphanLine(sb)}\n`);
  if (dryRun) return;

  if (!opts.yes) {
    const ok = await confirm({
      message: `Delete ${String(preview.orphans.length)} orphan sandbox(es)?`,
      initialValue: false,
    });
    if (!ok) {
      log.info('cancelled');
      return;
    }
  }
  const done = (await client.prune({ provider })) as HubApiPruneCloud;
  process.stdout.write(
    `${provider} prune: deleted ${String(done.deleted)}, failed ${String(done.failed)}` +
      (done.reaped > 0 ? `, control-box registrations reaped ${String(done.reaped)}` : '') +
      '\n',
  );
}

function orphanLine(sb: HubApiCloudOrphan): string {
  const parts = [sb.sandboxId];
  if (sb.name) parts.push(sb.name);
  if (sb.state) parts.push(sb.state);
  if (sb.createdAt) parts.push(sb.createdAt);
  return parts.join('  ');
}
