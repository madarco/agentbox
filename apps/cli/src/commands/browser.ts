import { spawnSync } from 'node:child_process';
import { log } from '@clack/prompts';
import {
  detectEngine,
  getBoxHostPaths,
  inspectBox,
  startBox,
  unpauseBox,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface BrowserOptions {
  print?: boolean;
  loopback?: boolean;
}

export const browserCommand = new Command('browser')
  .description(
    "Open a box's web app URL in the browser, even when no service declares `expose:` (auto-unpause/start)",
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--print', 'print the URL to stdout instead of launching the browser')
  .option('--loopback', 'use the 127.0.0.1 URL instead of the OrbStack .orb.local URL')
  .action(async (idOrName: string | undefined, opts: BrowserOptions) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      const insp = await inspectBox(box.id);
      if (insp.state === 'paused') {
        log.info('box is paused; unpausing');
        await unpauseBox(box.id);
      } else if (insp.state === 'stopped') {
        log.info('box is stopped; starting');
        await startBox(box.id);
      } else if (insp.state === 'missing') {
        throw new Error(`box ${box.name} has no container; was it destroyed?`);
      }

      // Re-read after a possible start: startBox re-resolves & persists the
      // reallocated webHostPort (lifecycle.ts).
      const { record } = await getBoxHostPaths(box.id);
      if (record.webContainerPort === undefined) {
        throw new Error(
          `box ${box.name} predates the reserved web port; recreate it to use \`agentbox browser\``,
        );
      }

      const engine = await detectEngine();
      let url: string;
      if (engine === 'orbstack' && !opts.loopback) {
        // OrbStack auto-routes <container>.orb.local to the container; :80 is
        // declared (EXPOSE 80) so no port suffix is needed.
        url = `http://${record.container}.orb.local`;
      } else {
        if (record.webHostPort === undefined) {
          throw new Error(
            `web port not resolved for box ${box.name}; is the container running? try \`agentbox inspect ${box.name}\``,
          );
        }
        url = `http://127.0.0.1:${String(record.webHostPort)}`;
      }

      if (opts.print) {
        process.stdout.write(`${url}\n`);
        return;
      }

      const opened = spawnSync('open', [url], { stdio: 'inherit' });
      if (opened.status !== 0) {
        throw new Error(`open ${url} failed (exit ${String(opened.status ?? 'n/a')})`);
      }
      process.stdout.write(`opened ${url}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
