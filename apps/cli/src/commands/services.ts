import type { BoxRecord, Provider } from '@agentbox/core';
import { renderStatusTable, type StatusReply } from '@agentbox/ctl';
import { boxRestartService, boxRestartServices, boxServicesStatusRaw } from '@agentbox/sandbox-core';
import { log } from '@clack/prompts';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

/**
 * `agentbox services <box>` — list and restart the services declared in a box's
 * `agentbox.yaml`, driven by the in-box `agentbox-ctl` supervisor. Provider-
 * agnostic: everything runs through `provider.exec`, so it works on docker and
 * the cloud providers alike (the box must be running — `agentbox-ctl` is only
 * reachable in a live box; `agentbox status` shows the persisted snapshot when
 * it isn't).
 */

/** Pull the live task/service/port snapshot, or null when the box isn't reachable. */
async function liveStatus(provider: Provider, box: BoxRecord): Promise<StatusReply | null> {
  const r = await boxServicesStatusRaw(provider, box).catch(() => null);
  if (!r || r.exitCode !== 0) return null;
  try {
    return JSON.parse(r.stdout) as StatusReply;
  } catch {
    return null;
  }
}

const listCommand = new Command('list')
  .description("List the box's services with their live state (running / ready / crashed / …)")
  .argument('[box]', 'box ref (default: the only box in this project)')
  .option('--json', 'print the raw live status (services, tasks, ports) as JSON')
  .action(async (idOrName: string | undefined, opts: { json?: boolean }) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const provider = await providerForBox(box);
      const live = await liveStatus(provider, box);
      if (!live) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ services: [], tasks: [], ports: [] }) + '\n');
          return;
        }
        log.error('could not reach the box supervisor (is the box running?). Try `agentbox status` for the persisted snapshot.');
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(live) + '\n');
        return;
      }
      if (live.services.length === 0) {
        process.stdout.write('no services declared in agentbox.yaml\n');
        return;
      }
      process.stdout.write(renderStatusTable(live.services) + '\n');
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
      const box = await resolveBoxOrExit(idOrName);
      const provider = await providerForBox(box);
      if (name) {
        const r = await boxRestartService(provider, box, name);
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.stderr) process.stderr.write(r.stderr);
        process.exit(r.exitCode);
      }
      // Restart-all: read the service list, then restart each in sequence.
      const live = await liveStatus(provider, box);
      if (!live) {
        log.error('could not reach the box supervisor (is the box running?)');
        process.exit(1);
      }
      const names = live.services.map((s) => s.name);
      if (names.length === 0) {
        process.stdout.write('no services to restart\n');
        return;
      }
      const results = await boxRestartServices(provider, box, names);
      let failed = 0;
      for (const { name: n, result } of results) {
        const okMark = result.exitCode === 0 ? 'ok' : `failed (exit ${String(result.exitCode)})`;
        process.stdout.write(`  ${n}  ${okMark}\n`);
        if (result.exitCode !== 0) {
          failed++;
          if (result.stderr) process.stderr.write(result.stderr);
        }
      }
      process.exit(failed > 0 ? 1 : 0);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

export const servicesCommand = new Command('services')
  .description("List and restart a box's agentbox.yaml services")
  .addCommand(listCommand, { isDefault: true })
  .addCommand(restartCommand);
