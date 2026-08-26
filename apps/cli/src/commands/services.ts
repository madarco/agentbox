import { renderStatusTable, type ServiceState, type ServiceStatus } from '@agentbox/ctl';
import { log } from '@clack/prompts';
import { Command } from 'commander';
import { resolveBoxOrExit, resolveBoxOrShift } from '../box-ref.js';
import type { HubApiServiceView } from '../control-plane/hub-api-client.js';
import { reportBoxNotOnAnyHub, withOwningHub } from '../control-plane/with-hub.js';
import { handleLifecycleError } from './_errors.js';

/**
 * `agentbox services <box>` — list and restart the services declared in a box's
 * `agentbox.yaml`, driven by the in-box `agentbox-ctl` supervisor.
 *
 * Both subcommands go through the hub's public `/api/v1`
 * (`GET|POST /boxes/:id/services*` via {@link withOwningHub} — box-scoped, so it
 * targets the hub that OWNS the box: the local hub for docker/remote-docker, the
 * configured hub for cloud; a plain `withHubClient` would send a docker box's op
 * to a configured remote control box that never owned it and get `not_found`), so
 * they work identically against a local hub and a remote control box — the hub runs the
 * box's `provider.exec` (it holds the credentials), and returns the SAME shared
 * `boxServicesStatusRaw` / `boxRestartService` result the CLI used to compute
 * inline. Unlike the old inline path, a paused/stopped box now reports its
 * PERSISTED service snapshot (the route falls back to it when the supervisor
 * isn't reachable), so `agentbox services` agrees with `agentbox status`.
 */

/** Adapt the API's compact `ServiceView` to the `ServiceStatus` `renderStatusTable`
 * expects — it only reads name/state/pid/restarts/lastExitCode/blockedOn/command,
 * so the timing fields are inert placeholders. */
function toStatusRows(services: HubApiServiceView[]): ServiceStatus[] {
  return services.map((s) => ({
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
  }));
}

const listCommand = new Command('list')
  .description("List the box's services with their live state (running / ready / crashed / …)")
  .argument('[box]', 'box ref (default: the only box in this project)')
  .option('--json', 'print the raw status (services, tasks, ports) as JSON')
  .action(async (idOrName: string | undefined, opts: { json?: boolean }) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const r = await withOwningHub(box, async (client) => {
        const svc = await client.getServices(box.id);
        if (opts.json) {
          process.stdout.write(JSON.stringify(svc) + '\n');
          return;
        }
        if (svc.source === 'unavailable') {
          log.error(
            'could not reach the box supervisor or find a persisted snapshot (is the box running?). Try `agentbox status` for details.',
          );
          process.exitCode = 1;
          return;
        }
        if (svc.services.length === 0) {
          process.stdout.write('no services declared in agentbox.yaml\n');
          return;
        }
        process.stdout.write(renderStatusTable(toStatusRows(svc.services)) + '\n');
      });
      if (r === 'not-found') reportBoxNotOnAnyHub(box);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const restartCommand = new Command('restart')
  .description('Restart one service, or every service when no name is given')
  .argument('[box]', 'box ref (default: the only box in this project)')
  .argument('[name]', 'service to restart (omit to restart all)')
  .action(async (idOrName: string | undefined, name: string | undefined) => {
    try {
      // On a single-box project `restart <svc>` binds <svc> to [box]; resolveBoxOrShift
      // re-treats it as the service name on the auto-picked box (like shell/logs), so
      // the box ref stays optional the same way `list`/`status` allow omitting it.
      const { box, shifted } = await resolveBoxOrShift(idOrName);
      const serviceName = shifted ? idOrName : name;
      const outcome = await withOwningHub(box, async (client) => {
        // The route restarts one service (with `name`) or every service (without),
        // reading the service list + looping server-side. A non-zero restart comes
        // back as a HubApiError that withHubClient maps to an exit code + message.
        const r = await client.restartService(box.id, serviceName);
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.stderr) process.stderr.write(r.stderr);
        if (!serviceName && r.ok) process.stdout.write('restarted all services\n');
      });
      if (outcome === 'not-found') reportBoxNotOnAnyHub(box);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

export const servicesCommand = new Command('services')
  .description("List and restart a box's agentbox.yaml services")
  .addCommand(listCommand, { isDefault: true })
  .addCommand(restartCommand);
