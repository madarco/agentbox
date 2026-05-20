import { log, spinner } from '@clack/prompts';
import {
  ensureRelay,
  getRelayStatus,
  stopRelay,
  type RelayStatus,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { handleLifecycleError } from './_errors.js';

interface StatusOpts {
  json?: boolean;
}

function renderStatus(s: RelayStatus): string {
  if (s.running && s.health) {
    return [
      'relay: running',
      `  pid:    ${s.pid === null ? '?' : String(s.pid)}`,
      `  port:   ${String(s.port)}`,
      `  url:    ${s.endpoint.hostUrl}`,
      `  boxes:  ${String(s.health.boxes)}`,
      `  events: ${String(s.health.events)}`,
      `  log:    ${s.logFile}`,
    ].join('\n');
  }
  if (s.pidAlive) {
    return [
      `relay: not responding (pid ${String(s.pid)} alive but /healthz silent)`,
      `  log:    ${s.logFile}`,
    ].join('\n');
  }
  return ['relay: not running', `  log:    ${s.logFile}`].join('\n');
}

const statusSub = new Command('status')
  .description('Show whether the host relay is running, with pid / port / box count')
  .option('--json', 'emit RelayStatus as JSON')
  .action(async (opts: StatusOpts) => {
    try {
      const s = await getRelayStatus();
      if (opts.json) {
        process.stdout.write(JSON.stringify(s, null, 2) + '\n');
        return;
      }
      process.stdout.write(renderStatus(s) + '\n');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const stopSub = new Command('stop')
  .description('Stop the host relay process (idempotent)')
  .action(async () => {
    try {
      const s = spinner();
      s.start('stopping relay');
      const result = await stopRelay();
      s.stop(
        result.stopped
          ? `stopped relay (pid ${String(result.pid)})`
          : 'relay was not running',
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const startSub = new Command('start')
  .description('Start the host relay if not already running (idempotent)')
  .action(async () => {
    try {
      const s = spinner();
      s.start('starting relay');
      const ep = await ensureRelay();
      s.stop(`relay running on ${ep.hostUrl}`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const restartSub = new Command('restart')
  .description('Stop then start the host relay')
  .action(async () => {
    try {
      const s = spinner();
      s.start('stopping relay');
      const stopped = await stopRelay();
      s.stop(
        stopped.stopped
          ? `stopped relay (pid ${String(stopped.pid)})`
          : 'relay was not running',
      );
      const s2 = spinner();
      s2.start('starting relay');
      try {
        const ep = await ensureRelay();
        s2.stop(`relay running on ${ep.hostUrl}`);
      } catch (err) {
        s2.stop('relay start failed');
        log.warn(err instanceof Error ? err.message : String(err));
        throw err;
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

export const relayCommand = new Command('relay')
  .description('Manage the host relay process (status / stop / start / restart)')
  .addCommand(statusSub, { isDefault: true })
  .addCommand(stopSub)
  .addCommand(startSub)
  .addCommand(restartSub);
