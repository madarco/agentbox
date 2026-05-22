import { confirm, isCancel, log } from '@clack/prompts';
import { Command } from 'commander';
import {
  DEFAULT_BOX_IMAGE,
  pullOpencodeConfig,
  resolveOpencodeVolume,
  SHARED_OPENCODE_VOLUME,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface DownloadOpencodeOpts {
  yes?: boolean;
  dryRun?: boolean;
}

export const downloadOpencodeCommand = new Command('opencode')
  .description(
    'Download box-side OpenCode config/auth (auth.json, opencode.json, agents, commands, themes) back to host ~/.config + ~/.local/share opencode (additive)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', "list new items and exit; don't write")
  .action(async (idOrName: string | undefined, opts: DownloadOpencodeOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      // We read the opencode-config *volume*, not the container, so the box can
      // be stopped — no unpause/start dance.
      const volume =
        box.opencodeConfigVolume ?? resolveOpencodeVolume({ isolate: false, boxId: box.id }).volume;
      if (volume === SHARED_OPENCODE_VOLUME) {
        log.warn(
          `Reading the shared ${SHARED_OPENCODE_VOLUME} volume — it aggregates OpenCode config from ANY box, not just ${box.name}.`,
        );
      }
      const image = box.image || DEFAULT_BOX_IMAGE;

      const preview = await pullOpencodeConfig({ volume }, { image, dryRun: true });

      if (preview.newItems.length === 0) {
        process.stdout.write('no new OpenCode config to download\n');
        return;
      }

      for (const item of preview.newItems) process.stdout.write(`  ${item} (new)\n`);

      if (opts.dryRun) {
        process.stdout.write(
          `\n[dry-run] ${preview.newItems.length} item(s) would be downloaded\n`,
        );
        return;
      }

      if (!opts.yes) {
        const ok = await confirm({
          message: `Download ${preview.newItems.length} OpenCode item(s) into ~/.config + ~/.local/share opencode? (existing items are never overwritten)`,
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }

      const result = await pullOpencodeConfig({ volume }, { image, dryRun: false });
      process.stdout.write(`downloaded ${result.newItems.length} item(s)\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
