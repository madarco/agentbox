import { confirm, log } from '@agentbox/cli-kit';
import { Command } from 'commander';
import {
  agentBoxConfigDir,
  pullClaudeExtrasViaTransport,
  stageItemsViaTransport,
  type PullClaudeResult,
} from '@agentbox/sandbox-core';
import { resolveBoxOrExit } from '../box-ref.js';
import { pullTransportForBox } from './_agent-pull-transport.js';
import { parsePropagateFlag, runPropagateStep } from './_agent-propagate.js';
import { handleLifecycleError } from './_errors.js';
import { claudeStagedItems } from '@agentbox/agent-claude';

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

      // One transport either way: a cloud box's provider transport, or the
      // agent's docker config VOLUME mounted at its box path (so the box can be
      // stopped — no unpause/start dance).
      const { transport } = await pullTransportForBox(box, 'claude');
      const pull = (dryRun: boolean): Promise<PullClaudeResult> =>
        pullClaudeExtrasViaTransport(transport, { dryRun });

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
          stageItemsViaTransport(transport, agentBoxConfigDir('claude'), items, stagingDir),
        scopeFlag,
        yes: opts.yes,
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });
