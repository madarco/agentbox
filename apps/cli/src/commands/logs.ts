import { log } from '@clack/prompts';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { withOwningHub } from '../control-plane/with-hub.js';
import { handleLifecycleError } from './_errors.js';

interface LogsOptions {
  tail: string;
  follow?: boolean;
  daemon?: boolean;
}

/**
 * `agentbox logs [box] <service>` — tail a box service log (or the ctl-daemon log
 * with `--daemon`). Runs through the hub's public `/api/v1`
 * (`GET /boxes/:id/logs`, snapshot or SSE for `-f`) via {@link withOwningHub}, so
 * it works identically against a local hub and a remote control box — the hub
 * spawns the in-box `agentbox-ctl logs` and returns / streams its output.
 */
export const logsCommand = new Command('logs')
  .description('Print recent log lines from a box service; -f to stream')
  // Both args optional so we can support `agentbox logs <service>` (auto-pick
  // the box) AND the original `agentbox logs <box> <service>`. Validation +
  // smart re-binding happens in the action handler.
  .argument(
    '[box]',
    'box ref (optional when cwd has exactly 1 box): project index, id, id prefix, name, or container',
  )
  .argument('[service]', 'service name from agentbox.yaml')
  .option('-n, --tail <n>', 'how many recent lines to print first', '200')
  .option('-f, --follow', 'keep the connection open and stream new lines')
  .option(
    '--daemon',
    "tail the in-box agentbox-ctl daemon log instead of a service log (the supervisor's own stdout/stderr)",
  )
  .action(async (boxArg: string | undefined, serviceArg: string | undefined, opts: LogsOptions) => {
    try {
      // Smart parse: if only one positional was given, commander binds it to
      // `boxArg` (the first positional). Treat that as the service and
      // auto-pick the box from the current project.
      let idOrName: string | undefined;
      let service: string | undefined;
      if (serviceArg !== undefined) {
        idOrName = boxArg;
        service = serviceArg;
      } else {
        idOrName = undefined;
        service = boxArg;
      }
      // `--daemon` reads the supervisor's own log file, not a service from
      // agentbox.yaml — accept no service arg in that case.
      if (!service && !opts.daemon) {
        log.error('missing <service> argument');
        log.info('usage: agentbox logs [box] <service> [-n N] [-f]');
        log.info('       agentbox logs [box] --daemon [-n N] [-f]');
        process.exit(2);
      }

      const box = await resolveBoxOrExit(idOrName);
      const tail = Number.parseInt(opts.tail, 10) || 200;
      const params = { service, tail, daemon: opts.daemon === true };

      if (!opts.follow) {
        const r = await withOwningHub(box, async (client) => {
          const { output } = await client.getBoxLogs(box.id, params);
          process.stdout.write(output);
          if (!output.endsWith('\n')) process.stdout.write('\n');
        });
        if (r === 'not-found') {
          log.error(`box ${box.name} was not found on any hub AgentBox knows.`);
          process.exit(2);
        }
        return;
      }

      // Follow: stream SSE from the owning hub. Ctrl-C aborts the request, which
      // tears down the hub-side spawned tail. The stream's terminal status maps to
      // the exit code (a failed/aborted tail is not a clean 0).
      const controller = new AbortController();
      const onSignal = (): void => controller.abort();
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      let status = 'gone';
      try {
        const r = await withOwningHub(box, async (client) => {
          const res = await client.streamBoxLog(
            box.id,
            params,
            (line) => process.stdout.write(line + '\n'),
            controller.signal,
          );
          status = res.status;
        });
        if (r === 'not-found') {
          log.error(`box ${box.name} was not found on any hub AgentBox knows.`);
          process.exit(2);
        }
        if (r === undefined) return; // hub error; withHubClient reported + set exit code
      } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
      // 'done'/'aborted' (clean end or user Ctrl-C) exit 0; a 'failed'/'error'
      // in-box tail exits 1 so scripts can tell a real failure from a clean stop.
      if (status === 'failed' || status === 'error') process.exit(1);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
