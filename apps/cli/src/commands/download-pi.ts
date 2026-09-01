import { confirm, log } from '@agentbox/cli-kit';
import { Command } from 'commander';
import { agentBoxConfigDir, agentPull, stageItemsViaTransport } from '@agentbox/sandbox-core';
import { resolveBoxOrExit } from '../box-ref.js';
import { pullTransportForBox } from './_agent-pull-transport.js';
import { parsePropagateFlag, runPropagateStep } from './_agent-propagate.js';
import { handleLifecycleError } from './_errors.js';
import { piStagedItems } from '@agentbox/agent-pi';

interface DownloadPiOpts {
  yes?: boolean;
  dryRun?: boolean;
  propagate?: string;
}

export const downloadPiCommand = new Command('pi')
  .description(
    'Download box-side Pi config (auth.json, settings.json, extensions, skills, prompts, themes, AGENTS.md) back to host ~/.pi/agent (additive), optionally propagating them to other boxes',
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
  .action(async (idOrName: string | undefined, opts: DownloadPiOpts) => {
    try {
      const scopeFlag = parsePropagateFlag(opts.propagate);
      const box = await resolveBoxOrExit(idOrName);

      // One transport either way: a cloud box's provider transport, or the
      // agent's docker config VOLUME mounted at its box path (so the box can be
      // stopped — no unpause/start dance).
      const { transport } = await pullTransportForBox(box, 'pi');
      const pull = (dryRun: boolean): Promise<{ newItems: string[] }> =>
        agentPull('pi', transport, { dryRun });

      const preview = await pull(true);

      if (preview.newItems.length === 0) {
        process.stdout.write('no new Pi config to download\n');
        return;
      }

      for (const item of preview.newItems) process.stdout.write(`  ${item} (new)\n`);

      if (opts.dryRun) {
        process.stdout.write(
          `\n[dry-run] ${preview.newItems.length} item(s) would be downloaded\n`,
        );
        return;
      }

      const applyToHost =
        opts.yes ||
        (await confirm({
          message: `Download ${preview.newItems.length} Pi item(s) into ~/.pi/agent? (existing items are never overwritten)`,
          initialValue: false,
        }));
      if (applyToHost) {
        const result = await pull(false);
        process.stdout.write(`downloaded ${result.newItems.length} item(s)\n`);
      } else {
        log.info('skipped the host write');
      }

      // Propagation stages from the source (volume or live box), so it works
      // whether or not the host write above was accepted.
      const items = piStagedItems(preview.newItems);
      await runPropagateStep({
        agent: 'pi',
        sourceBox: box,
        items,
        stage: (stagingDir) =>
          stageItemsViaTransport(transport, agentBoxConfigDir('pi'), items, stagingDir),
        scopeFlag,
        yes: opts.yes,
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });
