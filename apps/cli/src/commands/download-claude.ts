import { confirm, isCancel, log } from '@clack/prompts';
import { Command } from 'commander';
import {
  DEFAULT_BOX_IMAGE,
  pullClaudeExtras,
  resolveClaudeVolume,
  SHARED_CLAUDE_VOLUME,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface DownloadClaudeOpts {
  yes?: boolean;
  dryRun?: boolean;
}

function tag(item: { category: string; name: string }): string {
  const noun = item.category === 'plugins' ? 'plugin' : item.category.replace(/s$/, '');
  return `  ${item.category}/${item.name} (new ${noun})`;
}

export const downloadClaudeCommand = new Command('claude')
  .description(
    'Download box-installed Claude skills/plugins/agents/commands back to host ~/.claude (additive)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', "list new items and exit; don't write")
  .action(async (idOrName: string | undefined, opts: DownloadClaudeOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      // We read the claude-config *volume*, not the container, so the box can
      // be stopped — no unpause/start dance (unlike `download` / `download env`).
      const volume =
        box.claudeConfigVolume ?? resolveClaudeVolume({ isolate: false, boxId: box.id }).volume;
      if (volume === SHARED_CLAUDE_VOLUME) {
        log.warn(
          `Reading the shared ${SHARED_CLAUDE_VOLUME} volume — it aggregates Claude extensions installed in ANY box, not just ${box.name}.`,
        );
      }
      const image = box.image || DEFAULT_BOX_IMAGE;

      const preview = await pullClaudeExtras({ volume }, { image, dryRun: true });

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

      if (!opts.yes) {
        const ok = await confirm({
          message: `Download ${preview.newItems.length} new Claude extension(s) into ~/.claude? (existing items are never overwritten)`,
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }

      const result = await pullClaudeExtras({ volume }, { image, dryRun: false });
      process.stdout.write(
        `downloaded ${result.newItems.length} extension(s)` +
          `${result.mergedRegistries.length > 0 ? `, merged ${result.mergedRegistries.join(', ')}` : ''}` +
          ' into ~/.claude\n',
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });
