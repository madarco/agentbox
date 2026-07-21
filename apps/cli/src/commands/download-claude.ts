import { confirm, log } from '../lib/prompt.js';
import { Command } from 'commander';
import {
  DEFAULT_BOX_IMAGE,
  pullClaudeExtras,
  resolveClaudeVolume,
  SHARED_CLAUDE_VOLUME,
  stageItemsFromVolume,
} from '@agentbox/sandbox-docker';
import {
  agentBoxConfigDir,
  claudeStagedItems,
  pullClaudeExtrasViaTransport,
  stageItemsViaTransport,
  type PullClaudeResult,
} from '@agentbox/sandbox-core';
import type { SyncTransport } from '@agentbox/core';
import { resolveBoxOrExit } from '../box-ref.js';
import { cloudTransportForPull } from './_agent-pull.js';
import { parsePropagateFlag, runPropagateStep } from './_agent-propagate.js';
import { handleLifecycleError } from './_errors.js';

interface DownloadClaudeOpts {
  yes?: boolean;
  dryRun?: boolean;
  propagate?: string;
}

function tag(item: { category: string; name: string }): string {
  const noun = item.category === 'plugins' ? 'plugin' : item.category.replace(/s$/, '');
  return `  ${item.category}/${item.name} (new ${noun})`;
}

export const downloadClaudeCommand = new Command('claude')
  .description(
    'Download box-installed Claude skills/plugins/agents/commands back to host ~/.claude (additive), optionally propagating them to other boxes',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', "list new items and exit; don't write")
  .option(
    '--propagate <scope>',
    'also copy the pulled items into other boxes: project|all|none (default: ask)',
  )
  .action(async (idOrName: string | undefined, opts: DownloadClaudeOpts) => {
    try {
      const scopeFlag = parsePropagateFlag(opts.propagate);
      const box = await resolveBoxOrExit(idOrName);

      let pull: (dryRun: boolean) => Promise<PullClaudeResult>;
      let transport: SyncTransport | undefined;
      let volume: string | undefined;
      let image = box.image || DEFAULT_BOX_IMAGE;
      if ((box.provider ?? 'docker') !== 'docker') {
        // Cloud: read the live box FS over the provider's SyncTransport.
        transport = await cloudTransportForPull(box);
        const t = transport;
        pull = (dryRun) => pullClaudeExtrasViaTransport(t, { dryRun });
      } else {
        // Docker: we read the claude-config *volume*, not the container, so the
        // box can be stopped — no unpause/start dance (unlike `download`).
        volume =
          box.claudeConfigVolume ?? resolveClaudeVolume({ isolate: false, boxId: box.id }).volume;
        if (volume === SHARED_CLAUDE_VOLUME) {
          log.warn(
            `Reading the shared ${SHARED_CLAUDE_VOLUME} volume — it aggregates Claude extensions installed in ANY box, not just ${box.name}.`,
          );
        }
        image = box.image || DEFAULT_BOX_IMAGE;
        const v = volume;
        pull = (dryRun) => pullClaudeExtras({ volume: v }, { image, dryRun });
      }

      const preview = await pull(true);

      if (preview.newItems.length === 0 && preview.mergedRegistries.length === 0) {
        process.stdout.write('no new Claude extensions to download into ~/.claude\n');
        return;
      }

      for (const item of preview.newItems) process.stdout.write(`${tag(item)}\n`);
      for (const reg of preview.mergedRegistries) {
        process.stdout.write(`  plugins/${reg} (merge new entries)\n`);
      }

      if (opts.dryRun) {
        process.stdout.write(
          `\n[dry-run] ${preview.newItems.length} item(s)` +
            `${preview.mergedRegistries.length > 0 ? ` + ${preview.mergedRegistries.length} registry merge(s)` : ''}` +
            ` would be downloaded into ~/.claude\n`,
        );
        return;
      }

      const applyToHost =
        opts.yes ||
        (await confirm({
          message: `Download ${preview.newItems.length} new Claude extension(s) into ~/.claude? (existing items are never overwritten)`,
          initialValue: false,
        }));
      if (applyToHost) {
        const result = await pull(false);
        process.stdout.write(
          `downloaded ${result.newItems.length} extension(s)` +
            `${result.mergedRegistries.length > 0 ? `, merged ${result.mergedRegistries.join(', ')}` : ''}` +
            ' into ~/.claude\n',
        );
      } else {
        log.info('skipped the host ~/.claude write');
      }

      // Propagation stages from the source (volume or live box), so it works
      // whether or not the host write above was accepted.
      const items = claudeStagedItems(preview);
      await runPropagateStep({
        agent: 'claude',
        sourceBox: box,
        items,
        sourceRegistries: preview.sourceRegistries,
        stage: (stagingDir) =>
          transport
            ? stageItemsViaTransport(transport, agentBoxConfigDir('claude'), items, stagingDir)
            : stageItemsFromVolume(volume!, image, items, stagingDir),
        scopeFlag,
        yes: opts.yes,
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });
