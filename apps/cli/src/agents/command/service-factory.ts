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
import type { AgentSyncSpec } from '@agentbox/core';
import { renderStatusTable, type ServiceState, type ServiceStatus } from '@agentbox/ctl';
import { readBoxStatus } from '@agentbox/sandbox-docker';
import { modelAuthHelp } from '../../lib/model-auth-gate.js';
import { webProxyWarning } from '../../lib/web-proxy-warning.js';
import { openServiceRepl } from '../service-repl.js';
import { ATTACH_IN_HELP, INLINE_HELP, resolveAttachInOption } from '../../commands/_attach-in.js';
import { hostAwareOpenIn } from '../../terminal/host.js';
import { loadEffectiveConfig } from '@agentbox/config';
import { reattachRef, resolveBoxOrExit } from '../../box-ref.js';
import { findProjectRoot } from '@agentbox/config';
import { UserFacingError } from '@agentbox/core';
import { handleLifecycleError } from '../../commands/_errors.js';
import { reportBoxNotOnAnyHub, withOwningHub } from '../../control-plane/with-hub.js';
import type { HubApiServiceView } from '../../control-plane/hub-api-client.js';
import {
  findExistingBox,
  readServiceUrlFields,
  resolveServiceUrl,
  serviceSignInUrl,
  runServiceAgent,
  stopUnit,
  type ServiceAgentOptions,
} from './service-action.js';

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
    // Absent on a box whose ctl predates the field; `false` is what every other
    // reader means by that (see `BoxStatusServiceEntry.probed`).
    probed: s.probed ?? false,
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
    .option(
      '--carry <mode>',
      "'skip' disables carry for this run; 'ask' re-opens an approval this project already gave",
    )
    .option(
      '--persistent',
      'always-on box (the default for a service agent: a daemon that autopause reaps is an outage)',
    )
    .option(
      '--no-persistent',
      'create an expendable box instead — it can be auto-paused, idle-lapsed and pruned',
    )
    .option('--timeout <seconds>', 'how long to wait for the service to report ready', '180')
    .option('--verbose', 'stream create progress instead of a spinner')
    .option('--model-auth <source...>', modelAuthHelp(spec))
    .option(
      '--restore <bot>',
      `recreate a bot from its backup under <project>/.agentbox/bots/<bot>/: the box runs on a copy of the backed-up workspace AND gets the captured ${spec.id} state dir back, identity included. Always creates a new box`,
    )
    .option('--stamp <stamp>', 'which --restore backup to use (default: the `latest` link)')
    .option(
      '--into <dir>',
      'dir the restored workspace lives in (default: <project>/.agentbox/bots/<bot>/workspace)',
    )
    .option(
      '--force',
      'with --restore: proceed even when the backed-up box still runs, or the destination is not empty',
    )
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
      .description(
        `Print the URL the ${spec.id} service is published on` +
          (service.urlFields?.length
            ? `, plus its ${service.urlFields.map((f) => f.label).join(' and ')}`
            : ''),
      )
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
          // The URL alone is not enough to open a gateway's Control UI: it
          // asks for the token on first load. The extra values go on their own
          // lines AFTER the URL so `<agent> url | head -1` still yields just
          // the URL — and the whole thing is ONE write, because a second write
          // after `head` has closed the pipe raises EPIPE and would turn that
          // documented idiom into a node stack trace.
          const extra = await readServiceUrlFields(box, service.urlFields ?? []);
          // The ready-to-open link goes AFTER the bare URL, not in place of it:
          // line 1 is the documented `| head -1` surface, and a fragment on it
          // would break anything that appends a path to what it reads.
          const signIn = serviceSignInUrl(url, extra);
          process.stdout.write(
            [
              url,
              ...extra.map((f) => `${f.label}: ${f.value}`),
              ...(signIn ? [`open: ${signIn}`] : []),
              '',
            ].join('\n'),
          );
          // STDERR on purpose: stdout here is the documented `| head -1` surface,
          // and a warning printed into it would BE the first line.
          const warning = webProxyWarning(await readBoxStatus(box));
          if (warning) process.stderr.write(`warning: ${warning}\n`);
        } catch (err) {
          handleLifecycleError(err);
        }
      }),
  );

  // `attach` only for a daemon that ships a client to attach TO. A service
  // agent without one keeps the honest surface it had: nothing to open.
  const replArgv = service.repl;
  if (replArgv && replArgv.length > 0) {
    command.addCommand(
      new Command('attach')
        .description(
          `Open ${spec.id}'s terminal client against the box's running ${service.name} ` +
            `(starts the session on first use; Control+a d detaches and leaves the daemon up)`,
        )
        .argument('[box]', BOX_REF_HELP)
        // The same two flags the TUI factory's `attach` carries, and NOT
        // optional here: `runWrappedAttach` re-invokes this very command as
        // `<agent> attach <box> --attach-in same` to open a new pane for
        // `attach.openIn: split|window|tab`. Without them commander rejects its
        // own re-entry and the pane dies instead of showing the REPL.
        .option('--attach-in <mode>', ATTACH_IN_HELP)
        .option('-i, --inline', INLINE_HELP)
        .action(
          async (idOrName: string | undefined, opts: { attachIn?: string; inline?: boolean }) => {
            try {
              // Narrowed by agent, not `resolveBoxOrExit`: a bare
              // `agentbox <agent> attach` in a project whose only box belongs
              // to ANOTHER agent would otherwise open this client inside that
              // sandbox, where the daemon is not even installed. Same resolver
              // the root command uses.
              const project = await findProjectRoot(process.cwd());
              const box = await findExistingBox(idOrName, project.root, spec.id);
              if (!box) {
                throw new UserFacingError(
                  idOrName === undefined
                    ? `no ${spec.id} box in this project — run \`agentbox ${spec.id}\` to make one`
                    : `no box matched "${idOrName}"`,
                );
              }
              const attachIn = resolveAttachInOption(opts);
              const cfg = await loadEffectiveConfig(box.workspacePath, {
                cliOverrides: attachIn ? { attach: { openIn: attachIn } } : {},
              });
              await openServiceRepl({
                box,
                spec,
                argv: replArgv,
                reattach: reattachRef(box),
                openIn: hostAwareOpenIn(cfg),
              });
            } catch (err) {
              handleLifecycleError(err);
            }
          },
        ),
    );
  }

  return command;
}
