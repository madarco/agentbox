/**
 * `buildServiceAgentCommand(spec)` — the commander tree for a `surface:
 * 'service'` agent.
 *
 * The sibling of `buildAgentCommand`, not a mode of it. That factory's whole
 * surface assumes a TUI: `attach`, `login`, `--resume`/`-c`, `-i` queue jobs,
 * `--dangerously-skip-permissions`, teleport, the dashboard compositor. None of
 * them mean anything for a daemon, and offering a flag that silently does
 * nothing is worse than not offering it (the lesson `-c` on opencode taught).
 *
 * What a service agent gets instead is the shape a hosted service actually has:
 *
 *   agentbox <agent> [box]        create-or-resume, wait for ready, print the URL
 *   agentbox <agent> status       the supervisor's view of its unit
 *   agentbox <agent> logs         tail the unit's log
 *   agentbox <agent> restart      restart the unit
 *   agentbox <agent> stop         stop the unit (the box keeps running)
 *   agentbox <agent> url          print the URL
 *
 * Every subcommand is a thin wrapper over machinery that already exists — the
 * hub's `/api/v1` services + logs routes, and `provider.resolveUrl` — so nothing
 * here is a second implementation of anything.
 *
 * The unit name comes from `spec.service.name`, which is also the name a user
 * overrides by declaring their own service of that name in `agentbox.yaml`. Both
 * halves reading the same field is what makes the override work.
 */

import { Command } from 'commander';
import { log } from '@agentbox/cli-kit';
import type { AgentSyncSpec, BoxRecord } from '@agentbox/core';
import { renderStatusTable, type ServiceState, type ServiceStatus } from '@agentbox/ctl';
import { resolveBoxOrExit } from '../../box-ref.js';
import { handleLifecycleError } from '../../commands/_errors.js';
import { providerForBox } from '../../provider/registry.js';
import { reportBoxNotOnAnyHub, withOwningHub } from '../../control-plane/with-hub.js';
import type { HubApiServiceView } from '../../control-plane/hub-api-client.js';
import { resolveServiceUrl, runServiceAgent, type ServiceAgentOptions } from './service-action.js';

const BOX_REF_HELP =
  'box ref: project index, id, id prefix, name, or container (default: the only box in this project)';

/** `HubApiServiceView` → the row shape `renderStatusTable` prints. */
function toStatusRow(s: HubApiServiceView): ServiceStatus {
  return {
    name: s.name,
    state: s.state as ServiceState,
    pid: s.pid,
    restarts: s.restarts,
    lastExitCode: s.lastExitCode,
    startedAt: null,
    readyAt: null,
    nextRetryAt: null,
    blockedOn: s.blockedOn,
    command: s.command,
  };
}

export function buildServiceAgentCommand(spec: AgentSyncSpec): Command {
  const service = spec.service;
  if (!service) {
    throw new Error(`buildServiceAgentCommand: agent '${spec.id}' declares no service block`);
  }
  const unit = service.name;

  const command = new Command(spec.id)
    .description(`Create or resume a box hosting the ${spec.id} service, and print its URL`)
    .argument('[box]', BOX_REF_HELP)
    .option('-w, --workspace <path>', 'host workspace to mount', process.cwd())
    .option('-n, --name <name>', 'friendly box name (default: <workspace-basename>-<id>)')
    .option('-p, --provider <name>', 'sandbox backend (default: box.provider)')
    .option('--image <ref>', 'override the box image')
    .option('--snapshot <ref>', 'start from a project checkpoint (see `agentbox checkpoint`)')
    .option('-y, --yes', 'skip prompts, accept defaults')
    .option('--carry-yes', 'auto-approve the agentbox.yaml carry: block')
    .option('--carry <mode>', "'skip' disables carry for this run")
    .option('--timeout <seconds>', 'how long to wait for the service to report ready', '180')
    .option('--verbose', 'stream create progress instead of a spinner')
    .action(async (boxRef: string | undefined, opts: ServiceAgentOptions) => {
      await runServiceAgent(spec, boxRef, opts);
    });

  command.addCommand(
    new Command('status')
      .description(`Show the supervisor state of the ${unit} service`)
      .argument('[box]', BOX_REF_HELP)
      .action(async (idOrName: string | undefined) => {
        try {
          const box = await resolveBoxOrExit(idOrName);
          const r = await withOwningHub(box, async (client) => {
            const svc = await client.getServices(box.id);
            const row = svc.services.find((s) => s.name === unit);
            if (!row) {
              log.error(
                `the box supervisor has no "${unit}" unit yet — it arrives with the agent descriptor (\`agentbox-ctl reload\` re-applies it)`,
              );
              process.exitCode = 1;
              return;
            }
            process.stdout.write(renderStatusTable([toStatusRow(row)]) + '\n');
          });
          if (r === 'not-found') reportBoxNotOnAnyHub(box);
        } catch (err) {
          handleLifecycleError(err);
        }
      }),
  );

  command.addCommand(
    new Command('logs')
      .description(`Tail the ${unit} service log`)
      .argument('[box]', BOX_REF_HELP)
      .option('-n, --tail <lines>', 'lines to show', '200')
      .option('-f, --follow', 'stream new lines as they arrive')
      .action(async (idOrName: string | undefined, opts: { tail: string; follow?: boolean }) => {
        try {
          const box = await resolveBoxOrExit(idOrName);
          const tail = Number(opts.tail);
          if (!Number.isFinite(tail) || tail <= 0)
            throw new Error('--tail must be a positive number');
          const r = await withOwningHub(box, async (client) => {
            if (opts.follow) {
              await client.streamBoxLog(box.id, { service: unit, tail }, (line) =>
                process.stdout.write(line + '\n'),
              );
              return;
            }
            const { output } = await client.getBoxLogs(box.id, { service: unit, tail });
            process.stdout.write(output.endsWith('\n') ? output : output + '\n');
          });
          if (r === 'not-found') reportBoxNotOnAnyHub(box);
        } catch (err) {
          handleLifecycleError(err);
        }
      }),
  );

  command.addCommand(
    new Command('restart')
      .description(`Restart the ${unit} service`)
      .argument('[box]', BOX_REF_HELP)
      .action(async (idOrName: string | undefined) => {
        try {
          const box = await resolveBoxOrExit(idOrName);
          const r = await withOwningHub(box, async (client) => {
            await client.restartService(box.id, unit);
            log.success(`restarted ${unit}`);
          });
          if (r === 'not-found') reportBoxNotOnAnyHub(box);
        } catch (err) {
          handleLifecycleError(err);
        }
      }),
  );

  command.addCommand(
    new Command('stop')
      .description(`Stop the ${unit} service (the box keeps running)`)
      .argument('[box]', BOX_REF_HELP)
      .action(async (idOrName: string | undefined) => {
        try {
          const box = await resolveBoxOrExit(idOrName);
          // The hub's services route exposes restart but not stop, so this one
          // goes through `provider.exec` to the box's own ctl. Tracked in
          // docs/plans/service-boxes-backlog.md — the route belongs behind
          // /api/v1 like every other box operation.
          await stopUnit(box, unit);
          log.success(`stopped ${unit}`);
        } catch (err) {
          handleLifecycleError(err);
        }
      }),
  );

  command.addCommand(
    new Command('url')
      .description(`Print the URL the ${spec.id} service is published on`)
      .argument('[box]', BOX_REF_HELP)
      .action(async (idOrName: string | undefined) => {
        try {
          const box = await resolveBoxOrExit(idOrName);
          if (!service.expose) {
            log.error(`${spec.id} declares no expose: — it publishes no box URL`);
            process.exitCode = 1;
            return;
          }
          const url = await resolveServiceUrl(box);
          if (!url) {
            log.error(`could not resolve a web URL for ${box.name} (is it running?)`);
            process.exitCode = 1;
            return;
          }
          process.stdout.write(url + '\n');
        } catch (err) {
          handleLifecycleError(err);
        }
      }),
  );

  return command;
}

async function stopUnit(box: BoxRecord, unit: string): Promise<void> {
  const provider = await providerForBox(box);
  const r = await provider.exec(box, ['agentbox-ctl', 'stop', unit], { user: 'vscode' });
  if (r.exitCode !== 0) {
    throw new Error(
      `agentbox-ctl stop ${unit} failed: ${r.stderr.trim() || `exit ${String(r.exitCode)}`}`,
    );
  }
}
