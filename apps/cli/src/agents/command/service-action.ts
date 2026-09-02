/**
 * The body of `agentbox <service-agent>` — bring up a box that HOSTS a daemon.
 *
 * The TUI path (`create-action.ts`) ends at `startSession` → `attachWrapped`: a
 * tmux session and a terminal handed to the user. A service agent has neither.
 * It ends at "the service reported ready, here is its URL", which is why this is
 * a separate action rather than a flag on that one — `AgentRuntime` requires a
 * `startSession` that makes a tmux session and a `buildAttachArgv` that returns
 * an attach argv, and a daemon can satisfy neither.
 *
 * What it DOES share is everything that isn't the ending: config resolution, the
 * carry gate (which is how a secret reaches the box — see the layered-config
 * docs), provider routing and `provider.create`.
 *
 * The service itself is never started here. It is a ctl unit, synthesized from
 * the agent's `service` block and applied by the in-box supervisor when
 * `agents.list` answers — so a box that already exists runs it on start, with no
 * host involvement at all. This command only waits for it.
 */

import { findProjectRoot, loadEffectiveConfig, resolveBoxImage } from '@agentbox/config';
import type { AgentSyncSpec, BoxRecord, ResolvedCarryEntry } from '@agentbox/core';
import { intro, log, outro, makeProgressReporter, openCommandLog } from '@agentbox/cli-kit';
import { ensureAgentInstalled, readState, resolveBoxRef } from '@agentbox/sandbox-core';
import { recordLastAgent } from '@agentbox/sandbox-docker';
import { runCarryGate } from '../../lib/carry-gate.js';
import { handleLifecycleError } from '../../commands/_errors.js';
import { providerForBox, providerForCreate } from '../../provider/registry.js';
import { resolveLimits } from '../../limits.js';
import { withOwningHub } from '../../control-plane/with-hub.js';
import type { HubApiServiceView } from '../../control-plane/hub-api-client.js';

/** Flags the service create surface accepts. Deliberately a small subset. */
export interface ServiceAgentOptions {
  workspace: string;
  name?: string;
  provider?: string;
  image?: string;
  snapshot?: string;
  yes?: boolean;
  verbose?: boolean;
  carryYes?: boolean;
  carry?: 'skip' | 'ask';
  /** Seconds to wait for the service to report ready. */
  timeout?: string;
}

/**
 * Is this service up, by the SUPERVISOR'S OWN rule?
 *
 * `Supervisor.onServiceState` satisfies a unit at `ready` when it declares a
 * `ready_when` probe and at `running` when it does not — and a probed service
 * enters `running` the instant its process is spawned, long before the probe
 * passes. Accepting `running` for everything therefore reported a launch that
 * had not happened: the URL was printed while `/healthz` was still refused.
 *
 * `probed` is absent on a box whose ctl predates the field; treating that as
 * unprobed matches every other reader of the flag, and is the only choice that
 * cannot hang forever on a genuinely unprobed unit.
 */
function isUp(view: HubApiServiceView): boolean {
  return view.state === 'ready' || (view.state === 'running' && view.probed !== true);
}

/** States that will never become ready without intervention. */
const DEAD_STATES = new Set(['crashed', 'unhealthy', 'stopped']);

const DEFAULT_READY_TIMEOUT_S = 180;
const POLL_INTERVAL_MS = 2_000;

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_READY_TIMEOUT_S;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error('--timeout must be a positive number of seconds');
  return n;
}

/** Find an existing box for this ref/project without exiting when there is none. */
async function findExistingBox(
  ref: string | undefined,
  projectRoot: string,
): Promise<BoxRecord | null> {
  const state = await readState();
  const found = resolveBoxRef(ref, state, projectRoot);
  return found.kind === 'ok' ? found.box : null;
}

/**
 * Poll the box's supervisor until the agent's service is up.
 *
 * Through the hub's `/api/v1` like `agentbox services`, so it works identically
 * against a local hub and a remote control box — the hub holds the credentials
 * that let it run the box's `provider.exec`.
 */
export async function waitForService(
  box: BoxRecord,
  unit: string,
  timeoutSeconds: number,
  onProgress: (line: string) => void,
): Promise<HubApiServiceView> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last: HubApiServiceView | undefined;
  for (;;) {
    let view: HubApiServiceView | undefined;
    await withOwningHub(box, async (client) => {
      const svc = await client.getServices(box.id);
      view = svc.services.find((s) => s.name === unit);
    });
    if (view) {
      last = view;
      if (isUp(view)) return view;
      if (DEAD_STATES.has(view.state)) {
        throw new Error(
          `service "${unit}" is ${view.state}` +
            (view.lastExitCode === null ? '' : ` (exit ${String(view.lastExitCode)})`) +
            `. See \`agentbox logs ${box.name} ${unit}\`.`,
        );
      }
      onProgress(`waiting for ${unit} (${view.state})`);
    } else {
      // The unit is absent until `agents.list` answers and the supervisor
      // reloads — a short, bounded window on a cold box, by design.
      onProgress(`waiting for the supervisor to pick up ${unit}`);
    }
    if (Date.now() >= deadline) {
      // THROW, never warn-and-continue. A service that never came up must not
      // look like a completed launch: the caller (a script, CI, the queue) reads
      // the exit code, and returning 0 here tells it the gateway is serving when
      // nothing is listening.
      throw new Error(
        `service "${unit}" did not report ready within ${String(timeoutSeconds)}s` +
          (last
            ? ` (last state: ${last.state}${last.probed === true && last.state === 'running' ? ', its readiness probe has not passed' : ''})`
            : ' (the supervisor never picked it up)') +
          `. See \`agentbox logs ${box.name} ${unit}\`, or raise --timeout.`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/** The box's web URL, via the provider (docker and cloud both implement it). */
export async function resolveServiceUrl(box: BoxRecord): Promise<string | null> {
  try {
    const provider = await providerForBox(box);
    return await provider.resolveUrl(box, { kind: 'web' });
  } catch {
    return null;
  }
}

/**
 * `agentbox <agent> [box]` — create the box if it is missing, start it if it is
 * down, then wait for the service and print its URL.
 *
 * Create-or-resume rather than always-create: a service agent's box is the
 * long-lived thing the user comes back to, so typing the command twice must not
 * mean two gateways with two identities.
 */
export async function runServiceAgent(
  spec: AgentSyncSpec,
  boxRef: string | undefined,
  opts: ServiceAgentOptions,
): Promise<void> {
  const service = spec.service;
  if (!service) throw new Error(`agent ${spec.id} declares no service block`);
  const timeoutSeconds = parseTimeout(opts.timeout);
  const cmdLog = openCommandLog(spec.id);

  try {
    const project = await findProjectRoot(opts.workspace);
    const cfgLoaded = await loadEffectiveConfig(opts.workspace, {
      cliOverrides: opts.image ? { box: { image: opts.image } } : {},
    });
    const cfg = cfgLoaded.effective;

    intro(`agentbox ${spec.id}`);
    const existing = await findExistingBox(boxRef, project.root);
    let box: BoxRecord;

    if (existing) {
      box = existing;
      const provider = await providerForBox(box);
      const state = await provider.probeState(box);
      if (state === 'paused') await provider.resume(box);
      else if (state === 'stopped') box = await provider.start(box);
      else if (state === 'missing') {
        throw new Error(`box ${box.name} has no sandbox left; destroy it and run this again`);
      }
      log.info(`using box ${box.name}`);
    } else {
      if (boxRef !== undefined) {
        throw new Error(`no box matched "${boxRef}" — omit the ref to create one`);
      }
      // The carry gate is the supported way a real secret reaches the box: a
      // `carry:` entry lands it 0600 and the agent's config overlay references
      // it by name, so nothing secret is ever written into agentbox.yaml.
      let carry: ResolvedCarryEntry[] = [];
      const gate = await runCarryGate({
        projectRoot: project.root,
        yes: !!opts.yes,
        carryYesFlag: opts.carryYes ? true : undefined,
        carrySkipFlag: opts.carry === 'skip' ? true : undefined,
        onLog: (line) => cmdLog.write(line),
      });
      if (gate.decision === 'cancel') {
        log.warn('carry: cancelled — not creating the box');
        return;
      }
      if (gate.decision === 'approve') carry = gate.entries;

      const provider = await providerForCreate({ flag: opts.provider, config: cfg });
      const s = makeProgressReporter(opts.verbose === true);
      s.start('creating box');
      try {
        const created = await provider.create({
          workspacePath: opts.workspace,
          name: opts.name,
          projectRoot: project.root,
          agent: spec.id,
          // This box is FOR this agent: only its credentials and config are
          // wired in.
          agents: [spec.id],
          image: resolveBoxImage(cfg, provider.name),
          checkpointRef: opts.snapshot,
          withPlaywright: cfg.box.withPlaywright,
          withEnv: cfg.box.withEnv,
          carry,
          vnc: { enabled: cfg.box.vnc },
          limits: resolveLimits(cfg.box, {}),
          providerOptions: {
            // ISOLATION IS NOT A USER KNOB HERE. Two daemons sharing a state dir
            // share one identity — the gateway pairings of the first box would
            // be the second box's too — so a service agent always gets a per-box
            // config volume. Derived from `caps.surface`, never from a
            // `box.isolate<Agent>Config` key that could be set to false.
            agentConfig: { [spec.id]: { isolate: true } },
          },
          onLog: (line) => {
            s.message(line);
            cmdLog.write(line);
          },
        });
        box = created.record;
        s.stop(`box ready: ${box.name}`);
      } catch (err) {
        s.stop('create failed');
        throw err;
      }
      await recordLastAgent(box.id, spec.id).catch(() => {});
    }

    // A box restored from a snapshot baked before this agent existed has no
    // binary; the install recipe is data on the spec, so this is generic.
    const provider = await providerForBox(box);
    const transport = provider.syncTransport?.(box);
    if (transport) {
      const r = await ensureAgentInstalled(transport, spec.id, {
        onProgress: (line) => {
          log.info(line);
          cmdLog.write(line);
        },
      });
      if (r.installed) {
        log.info(`${spec.id} installed into this box; restarting the supervisor units`);
        await provider.exec(box, ['agentbox-ctl', 'reload'], { user: 'vscode' }).catch(() => {});
      }
    }

    const s = makeProgressReporter(opts.verbose === true);
    s.start(`waiting for ${service.name}`);
    let view: HubApiServiceView;
    try {
      view = await waitForService(box, service.name, timeoutSeconds, (line) => {
        s.message(line);
        cmdLog.write(line);
      });
      s.stop(`${service.name} ${view.state}`);
    } catch (err) {
      // Includes the ready timeout: `waitForService` throws rather than
      // returning, so the outro below is reached only by a service that is
      // genuinely up. `handleLifecycleError` turns this into a non-zero exit.
      s.stop(`${service.name} failed`);
      throw err;
    }

    const url = service.expose ? await resolveServiceUrl(box) : null;
    if (url) outro(`${spec.id} on ${box.name}: ${url}`);
    else outro(`${spec.id} on ${box.name}`);
  } catch (err) {
    cmdLog.write(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    handleLifecycleError(err);
  } finally {
    cmdLog.close();
  }
}
