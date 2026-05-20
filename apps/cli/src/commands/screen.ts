import { spawnSync } from 'node:child_process';
import { log } from '@clack/prompts';
import {
  buildVncUrls,
  detectEngine,
  ensureBoxBrowser,
  inspectBox,
  readBoxStatus,
  startBox,
  unpauseBox,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface ScreenOptions {
  print?: boolean;
  loopback?: boolean;
}

export const screenCommand = new Command('screen')
  .description("Open a box's VNC (noVNC) viewer in the browser (auto-unpause/start)")
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--print', 'print the URL to stdout instead of launching the browser')
  .option('--loopback', 'use the 127.0.0.1 URL instead of the OrbStack .orb.local URL')
  .action(async (idOrName: string | undefined, opts: ScreenOptions) => {
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
        log.info('box is stopped; starting');
        await startBox(box.id);
      } else if (insp.state === 'missing') {
        throw new Error(`box ${box.name} has no container; was it destroyed?`);
      }

      // Point the in-box browser at the box's own web service so the app is
      // shown *inside* the VNC desktop (the host browser only gets the noVNC
      // viewer). The expose port is reachable at 127.0.0.1:<port> inside the
      // box; absent a web service we fall back to a neutral page so the VNC
      // view isn't a connection-refused error.
      const persisted = await readBoxStatus(box);
      const exposePort = persisted?.services.find((s) => s.expose)?.expose?.port;
      const inBoxUrl =
        exposePort !== undefined ? `http://localhost:${String(exposePort)}` : 'about:blank';

      const br = await ensureBoxBrowser(box.container, undefined, inBoxUrl);
      if (br.up && !br.alreadyRunning) {
        log.info(
          exposePort !== undefined
            ? `opened ${inBoxUrl} in the in-box browser (visible in the VNC view)`
            : 'started in-box browser',
        );
      } else if (br.alreadyRunning) {
        log.info('in-box browser already running; left it untouched');
      } else {
        log.warn(`could not start in-box browser: ${br.reason ?? 'unknown'}`);
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
