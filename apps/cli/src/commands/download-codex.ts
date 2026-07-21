import { confirm, log } from '../lib/prompt.js';
import { Command } from 'commander';
import {
  DEFAULT_BOX_IMAGE,
  pullCodexConfig,
  resolveCodexVolume,
  SHARED_CODEX_VOLUME,
  stageItemsFromVolume,
} from '@agentbox/sandbox-docker';
import {
  agentBoxConfigDir,
  codexStagedItems,
  pullCodexConfigViaTransport,
  stageItemsViaTransport,
} from '@agentbox/sandbox-core';
import type { SyncTransport } from '@agentbox/core';
import { resolveBoxOrExit } from '../box-ref.js';
import { cloudTransportForPull } from './_agent-pull.js';
import { parsePropagateFlag, runPropagateStep } from './_agent-propagate.js';
import { handleLifecycleError } from './_errors.js';

interface DownloadCodexOpts {
  yes?: boolean;
  dryRun?: boolean;
  propagate?: string;
}

export const downloadCodexCommand = new Command('codex')
  .description(
    'Download box-side Codex config/auth (config.toml, auth.json, prompts) back to host ~/.codex (additive), optionally propagating them to other boxes',
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
  .action(async (idOrName: string | undefined, opts: DownloadCodexOpts) => {
    try {
      const scopeFlag = parsePropagateFlag(opts.propagate);
      const box = await resolveBoxOrExit(idOrName);

      let pull: (dryRun: boolean) => Promise<{ newItems: string[] }>;
      let transport: SyncTransport | undefined;
      let volume: string | undefined;
      let image = box.image || DEFAULT_BOX_IMAGE;
      if ((box.provider ?? 'docker') !== 'docker') {
        // Cloud: read the live box FS over the provider's SyncTransport.
        transport = await cloudTransportForPull(box);
        const t = transport;
        pull = (dryRun) => pullCodexConfigViaTransport(t, { dryRun });
      } else {
        // Docker: we read the codex-config *volume*, not the container, so the
        // box can be stopped — no unpause/start dance.
        volume =
          box.codexConfigVolume ?? resolveCodexVolume({ isolate: false, boxId: box.id }).volume;
        if (volume === SHARED_CODEX_VOLUME) {
          log.warn(
            `Reading the shared ${SHARED_CODEX_VOLUME} volume — it aggregates Codex config from ANY box, not just ${box.name}.`,
          );
        }
        image = box.image || DEFAULT_BOX_IMAGE;
        const v = volume;
        pull = (dryRun) => pullCodexConfig({ volume: v }, { image, dryRun });
      }

      const preview = await pull(true);

      if (preview.newItems.length === 0) {
        process.stdout.write('no new Codex config to download into ~/.codex\n');
        return;
      }

      for (const item of preview.newItems) process.stdout.write(`  ${item} (new)\n`);

      if (opts.dryRun) {
        process.stdout.write(
          `\n[dry-run] ${preview.newItems.length} item(s) would be downloaded into ~/.codex\n`,
        );
        return;
      }

      const applyToHost =
        opts.yes ||
        (await confirm({
          message: `Download ${preview.newItems.length} Codex item(s) into ~/.codex? (existing items are never overwritten)`,
          initialValue: false,
        }));
      if (applyToHost) {
        const result = await pull(false);
        process.stdout.write(`downloaded ${result.newItems.length} item(s) into ~/.codex\n`);
      } else {
        log.info('skipped the host ~/.codex write');
      }

      // Propagation stages from the source (volume or live box), so it works
      // whether or not the host write above was accepted.
      const items = codexStagedItems(preview.newItems);
      await runPropagateStep({
        agent: 'codex',
        sourceBox: box,
        items,
        stage: (stagingDir) =>
          transport
            ? stageItemsViaTransport(transport, agentBoxConfigDir('codex'), items, stagingDir)
            : stageItemsFromVolume(volume!, image, items, stagingDir),
        scopeFlag,
        yes: opts.yes,
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });
