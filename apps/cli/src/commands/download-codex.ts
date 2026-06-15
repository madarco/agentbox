import { confirm, log } from '../lib/prompt.js';
import { Command } from 'commander';
import {
  DEFAULT_BOX_IMAGE,
  pullCodexConfig,
  resolveCodexVolume,
  SHARED_CODEX_VOLUME,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface DownloadCodexOpts {
  yes?: boolean;
  dryRun?: boolean;
}

export const downloadCodexCommand = new Command('codex')
  .description(
    'Download box-side Codex config/auth (config.toml, auth.json, prompts) back to host ~/.codex (additive)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', "list new items and exit; don't write")
  .action(async (idOrName: string | undefined, opts: DownloadCodexOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      // We read the codex-config *volume*, not the container, so the box can
      // be stopped — no unpause/start dance.
      const volume =
        box.codexConfigVolume ?? resolveCodexVolume({ isolate: false, boxId: box.id }).volume;
      if (volume === SHARED_CODEX_VOLUME) {
        log.warn(
          `Reading the shared ${SHARED_CODEX_VOLUME} volume — it aggregates Codex config from ANY box, not just ${box.name}.`,
        );
      }
      const image = box.image || DEFAULT_BOX_IMAGE;

      const preview = await pullCodexConfig({ volume }, { image, dryRun: true });

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

      if (!opts.yes) {
        const ok = await confirm({
          message: `Download ${preview.newItems.length} Codex item(s) into ~/.codex? (existing items are never overwritten)`,
          initialValue: false,
        });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }

      const result = await pullCodexConfig({ volume }, { image, dryRun: false });
      process.stdout.write(`downloaded ${result.newItems.length} item(s) into ~/.codex\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
