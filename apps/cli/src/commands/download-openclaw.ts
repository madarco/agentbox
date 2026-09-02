/**
 * `agentbox download openclaw` — the box→host half of OpenClaw's sync.
 *
 * Additive and never-overwrite, like every other agent's download, and narrower
 * on purpose: the registry row's `pull` names `agents/` only. Everything else
 * under `~/.openclaw` is either IDENTITY (`openclaw.json`, the config-journal
 * key) or live state (`state/*.sqlite*`), and a gateway's identity must not be
 * copied anywhere — one identity in two live gateways is the failure OpenClaw
 * explicitly forbids.
 *
 * NO `--propagate`, for the same reason. Every other agent's download can fan
 * the pulled items into sibling boxes because those boxes are the same user's
 * one tool; an OpenClaw box is a TENANT, and pushing one tenant's agent
 * definitions into another's gateway is not a default anyone asked for.
 */

import { confirm, log } from '@agentbox/cli-kit';
import { Command } from 'commander';
import { agentPull } from '@agentbox/sandbox-core';
import { resolveBoxOrExit } from '../box-ref.js';
import { pullTransportForBox } from './_agent-pull-transport.js';
import { handleLifecycleError } from './_errors.js';

interface DownloadOpenclawOpts {
  yes?: boolean;
  dryRun?: boolean;
}

export const downloadOpenclawCommand = new Command('openclaw')
  .description(
    'Download box-side OpenClaw agent definitions (~/.openclaw/agents) back to the host (additive; the gateway config and state are never pulled)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', "list new items and exit; don't write")
  .action(async (idOrName: string | undefined, opts: DownloadOpenclawOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      // One transport either way: a cloud box's provider transport, or the
      // agent's docker config VOLUME mounted at its box path (so the box can be
      // stopped — no unpause/start dance).
      const { transport } = await pullTransportForBox(box, 'openclaw');
      const pull = (dryRun: boolean): Promise<{ newItems: string[] }> =>
        agentPull('openclaw', transport, { dryRun });

      const preview = await pull(true);
      if (preview.newItems.length === 0) {
        process.stdout.write('no new OpenClaw items to download\n');
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
          message: `Download ${preview.newItems.length} OpenClaw item(s) into ~/.openclaw? (existing items are never overwritten)`,
          initialValue: false,
        }));
      if (applyToHost) {
        const result = await pull(false);
        process.stdout.write(`downloaded ${result.newItems.length} item(s)\n`);
      } else {
        log.info('skipped the host write');
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
