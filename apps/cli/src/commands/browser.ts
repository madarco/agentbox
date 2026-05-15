import { spawnSync } from 'node:child_process';
import { log } from '@clack/prompts';
import { Command } from 'commander';
import {
  buildVncUrls,
  detectEngine,
  inspectBox,
  startBox,
  unpauseBox,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface BrowserOptions {
  print?: boolean;
  loopback?: boolean;
}

export const browserCommand = new Command('browser')
  .description("Open a box's VNC URL in the host's default browser (auto-unpause/start)")
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--print', 'print the URL to stdout instead of launching the browser')
  .option('--loopback', 'use the 127.0.0.1 URL instead of the OrbStack .orb.local URL')
  .action(async (idOrName: string | undefined, opts: BrowserOptions) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      if (!box.vncEnabled) {
        throw new Error(`VNC is disabled for box ${box.name} — recreate without \`--no-vnc\``);
      }

      const insp = await inspectBox(box.id);
      if (insp.state === 'paused') {
        log.info('box is paused; unpausing');
        await unpauseBox(box.id);
      } else if (insp.state === 'stopped') {
        log.info('box is stopped; starting (remounting overlay)');
        await startBox(box.id);
      } else if (insp.state === 'missing') {
        throw new Error(`box ${box.name} has no container; was it destroyed?`);
      }

      const engine = await detectEngine();
      const urls = buildVncUrls(box, engine);
      const url = opts.loopback ? urls.loopbackUrl : (urls.orbUrl ?? urls.loopbackUrl);
      if (!url) {
        throw new Error(
          `VNC URL unavailable (daemon may not be up); try \`agentbox inspect ${box.name}\``,
        );
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
