import { spawn } from 'node:child_process';
import { log, spinner } from '@clack/prompts';
import { ensureHub, getHubStatus, stopHub, type HubStatus } from '@agentbox/sandbox-docker';
import { hostOpenCommand } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { handleLifecycleError } from './_errors.js';
import { rehydrateFromState } from './relay.js';

/** Best-effort: open the hub URL in the host browser (never throws). */
function openInBrowser(url: string): void {
  try {
    const child = spawn(hostOpenCommand(), [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* the caller has already printed the URL */
  }
}

interface StatusOpts {
  json?: boolean;
}

function renderStatus(s: HubStatus): string {
  if (s.running) {
    return [
      `hub: running${s.ui ? '' : ' (bare relay on the port — no UI; run `agentbox hub start`)'}`,
      `  pid:  ${s.pid === null ? '?' : String(s.pid)}`,
      `  port: ${String(s.port)}`,
      `  url:  ${s.openUrl}`,
      `  log:  ${s.logFile}`,
    ].join('\n');
  }
  if (s.pidAlive) {
    return [`hub: not responding (pid ${String(s.pid)} alive but /healthz silent)`, `  log:  ${s.logFile}`].join('\n');
  }
  return ['hub: not running', `  log:  ${s.logFile}`].join('\n');
}

const statusSub = new Command('status')
  .description('Show whether the hub (relay + Web UI) is running, with its URL')
  .option('--json', 'emit HubStatus as JSON')
  .action(async (opts: StatusOpts) => {
    try {
      const s = await getHubStatus();
      if (opts.json) {
        process.stdout.write(JSON.stringify(s, null, 2) + '\n');
        return;
      }
      process.stdout.write(renderStatus(s) + '\n');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

interface StartOpts {
  open?: boolean;
}

const startSub = new Command('start')
  .description('Start the hub (relay + Web UI on port 8787) and open it')
  .option('--no-open', "don't open the browser, just print the URL")
  .action(async (opts: StartOpts) => {
    try {
      const s = spinner();
      s.start('starting hub');
      const ep = await ensureHub({ onLog: (line) => s.message(line) });
      await rehydrateFromState();
      s.stop(`hub running on ${ep.hostUrl}`);
      process.stdout.write(`\n  Open: ${ep.openUrl}\n\n`);
      if (opts.open !== false) openInBrowser(ep.openUrl);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const stopSub = new Command('stop')
  .description('Stop the hub process (idempotent)')
  .action(async () => {
    try {
      const s = spinner();
      s.start('stopping hub');
      const result = await stopHub();
      s.stop(result.stopped ? `stopped hub (pid ${String(result.pid)})` : 'hub was not running');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const restartSub = new Command('restart')
  .description('Stop then start the hub')
  .option('--no-open', "don't open the browser, just print the URL")
  .action(async (opts: StartOpts) => {
    try {
      const s = spinner();
      s.start('stopping hub');
      const stopped = await stopHub();
      s.stop(stopped.stopped ? `stopped hub (pid ${String(stopped.pid)})` : 'hub was not running');
      const s2 = spinner();
      s2.start('starting hub');
      try {
        const ep = await ensureHub({ onLog: (line) => s2.message(line) });
        await rehydrateFromState();
        s2.stop(`hub running on ${ep.hostUrl}`);
        process.stdout.write(`\n  Open: ${ep.openUrl}\n\n`);
        if (opts.open !== false) openInBrowser(ep.openUrl);
      } catch (err) {
        s2.stop('hub start failed');
        log.warn(err instanceof Error ? err.message : String(err));
        throw err;
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

export const hubCommand = new Command('hub')
  .description('Run the AgentBox hub — the relay + Web UI on http://127.0.0.1:8787')
  .addCommand(startSub, { isDefault: true })
  .addCommand(statusSub)
  .addCommand(stopSub)
  .addCommand(restartSub);
