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
import type {
  AgentServiceUrlField,
  AgentSyncSpec,
  BoxRecord,
  ResolvedCarryEntry,
} from '@agentbox/core';
import { persistentRefusal, resolveCreatePersistent, UserFacingError } from '@agentbox/core';
import { intro, log, outro, makeProgressReporter, openCommandLog } from '@agentbox/cli-kit';
import {
  clearBoxPortlessWebAlias,
  ensureAgentInstalled,
  readState,
  resolveBoxRef,
} from '@agentbox/sandbox-core';
import { portlessUnalias, readBoxStatus, recordLastAgent } from '@agentbox/sandbox-docker';
import { webProxyWarning } from '../../lib/web-proxy-warning.js';
import { runCarryGate } from '../../lib/carry-gate.js';
import { handleLifecycleError } from '../../commands/_errors.js';
import { providerForBox, providerForCreate } from '../../provider/registry.js';
import {
  assertSourceBoxNotRunning,
  resolveRestoreRequest,
  restoreStateIntoBox,
  stageRestoreWorkspace,
  type RestoreRequest,
} from '../../commands/_restore.js';
import { resolveLimits } from '../../limits.js';
import { resolveProviderChoice } from '../../provider/spec.js';
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
  /**
   * `--persistent` / `--no-persistent`. Undefined when neither was passed, which
   * is what lets the registry's surface supply the default.
   */
  persistent?: boolean;
  /** Seconds to wait for the service to report ready. */
  timeout?: string;
  /** `--restore <bot>`: recreate that bot from its backup, identity included. */
  restore?: string;
  /** `--stamp <s>`: which backup (default: the `latest` link). */
  stamp?: string;
  /** `--into <dir>`: where the restored workspace lives. */
  into?: string;
  /** `--force`: restore even when the source box runs / the destination is not empty. */
  force?: boolean;
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

/**
 * Find THIS agent's existing box for the ref/project, without exiting when
 * there is none.
 *
 * An explicit ref is the user naming a box, so it resolves as it does
 * everywhere else. With NO ref the bare command is create-or-resume, and the
 * candidate has to be narrowed to boxes this agent owns (`lastAgent`) — a
 * project's only box is very often somebody else's (a `claude` box), and
 * adopting it would install the daemon into it and reload its supervisor.
 * Resolving by project alone also went the other way: with two or more boxes it
 * matched none and silently built a SECOND gateway, which is the identity split
 * one-box-per-tenant exists to prevent.
 *
 * Two or more of this agent's own boxes is genuinely ambiguous, so it asks for
 * a ref instead of guessing.
 */
export async function findExistingBox(
  ref: string | undefined,
  projectRoot: string,
  agentId: string,
): Promise<BoxRecord | null> {
  const state = await readState();
  if (ref !== undefined) {
    const found = resolveBoxRef(ref, state, projectRoot);
    return found.kind === 'ok' ? found.box : null;
  }
  const mine = state.boxes.filter(
    (b) => b.workspacePath === projectRoot && b.lastAgent === agentId,
  );
  if (mine.length === 1) return mine[0] ?? null;
  if (mine.length > 1) {
    throw new UserFacingError(
      `this project has ${String(mine.length)} ${agentId} boxes (${mine
        .map((b) => b.name)
        .join(
          ', ',
        )}) — name the one you mean, e.g. \`agentbox ${agentId} ${mine[0]?.name ?? '<box>'}\``,
    );
  }
  return null;
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
  let restarted = false;
  for (;;) {
    let view: HubApiServiceView | undefined;
    // Abort on a hub-level failure instead of polling to `--timeout`: an
    // unreachable hub or a `not-found` box never resolves, and the sibling
    // commands (`status`, `logs`, `restart`) already stop on it.
    const outcome = await withOwningHub(box, async (client) => {
      const svc = await client.getServices(box.id);
      view = svc.services.find((s) => s.name === unit);
    });
    if (outcome !== 'ok') {
      throw new Error(
        outcome === 'not-found'
          ? `box ${box.name} is not known to its hub, so its services cannot be read. ` +
              'If it was created elsewhere, run `agentbox recover --adopt` first.'
          : `could not reach the hub that owns box ${box.name}. Run \`agentbox hub status\`.`,
      );
    }
    if (view) {
      last = view;
      if (isUp(view)) return view;
      // `stopped` is the one dead state the caller can fix: `<agent> stop`
      // leaves the unit down, and the bare command is documented as
      // create-or-resume. Start it once and keep waiting; a second `stopped`
      // means the start did not take, and falls through to the error below.
      if (view.state === 'stopped' && !restarted) {
        restarted = true;
        onProgress(`service "${unit}" was stopped; starting it`);
        await withOwningHub(box, async (client) => {
          await client.restartService(box.id, unit);
        });
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }
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

/** Walk a dotted path into a parsed JSON document. */
function atJsonPath(doc: unknown, path: string): unknown {
  let cur = doc;
  for (const seg of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * The extra values `<agent> url` prints beside the URL — a Control UI's gateway
 * token, read out of the daemon's own config file.
 *
 * Read on demand and never persisted: these are secrets, so they are fetched
 * when the user asks for them and are not written to the box record or the
 * command log.
 *
 * Best-effort per field. The service can be up before it has written the file
 * (or the tool may rename the key across a version), and a missing token must
 * not turn a working `url` into a failure — the URL is the thing the user
 * asked for.
 */
export async function readServiceUrlFields(
  box: BoxRecord,
  fields: readonly AgentServiceUrlField[],
): Promise<{ label: string; value: string }[]> {
  if (fields.length === 0) return [];
  const provider = await providerForBox(box);
  const out: { label: string; value: string }[] = [];
  // One read per distinct file, not per field: two fields out of one config
  // would otherwise be two `exec` round-trips into the box.
  const docs = new Map<string, unknown>();
  for (const field of fields) {
    if (!docs.has(field.file)) {
      let parsed: unknown;
      try {
        const r = await provider.exec(box, ['cat', field.file], { user: 'vscode' });
        parsed = r.exitCode === 0 ? JSON.parse(r.stdout) : undefined;
      } catch {
        parsed = undefined;
      }
      docs.set(field.file, parsed);
    }
    const value = atJsonPath(docs.get(field.file), field.jsonPath);
    if (typeof value === 'string' && value.length > 0) out.push({ label: field.label, value });
  }
  return out;
}

/**
 * Stop one supervisor unit in a box.
 *
 * Still a `provider.exec` rather than an API call: the hub's services routes
 * expose `restart` but not `stop` (recorded in the service-boxes backlog). Lives
 * here rather than in the factory because both callers — `<agent> stop` and the
 * restore below — need it, and the factory already imports this module.
 */
export async function stopUnit(box: BoxRecord, unit: string): Promise<void> {
  const provider = await providerForBox(box);
  const r = await provider.exec(box, ['agentbox-ctl', 'stop', unit], { user: 'vscode' });
  if (r.exitCode !== 0) {
    throw new Error(
      `agentbox-ctl stop ${unit} failed: ${r.stderr.trim() || `exit ${String(r.exitCode)}`}`,
    );
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
    // `--restore` is resolved and staged first: the restored tree becomes the
    // box's workspace, so its own `agentbox.yaml` is the one to load, and the
    // project root is that directory verbatim — it lives under the ORIGINAL
    // project's `.agentbox/`, so walking up would seed from the template.
    let restored: RestoreRequest | undefined;
    if (opts.restore) {
      restored = await resolveRestoreRequest(opts.workspace, opts);
      if (restored.agent && restored.agent !== spec.id) {
        throw new Error(
          `${restored.bundle.dir} holds ${restored.agent} state, not ${spec.id} — ` +
            `restore it with \`agentbox ${restored.agent} --restore ${restored.bundle.bot}\``,
        );
      }
      await assertSourceBoxNotRunning(restored.bundle, opts.force);
      opts.workspace = restored.workspaceDir;
    }
    const project = restored
      ? { root: restored.workspaceDir }
      : await findProjectRoot(opts.workspace);
    const cfgLoaded = await loadEffectiveConfig(opts.workspace, {
      cliOverrides: opts.image ? { box: { image: opts.image } } : {},
    });
    const cfg = cfgLoaded.effective;

    intro(`agentbox ${spec.id}`);
    const existing = await findExistingBox(boxRef, project.root, spec.id);
    // A restore always makes a NEW box. The bare command is create-or-resume, so
    // without this a second `--restore` would push a bundle's identity over a
    // running bot's — the one thing this feature must never do by accident.
    if (restored && existing) {
      throw new Error(
        `box ${existing.name} already exists for this restore dir; ` +
          `pass --into <dir> or -n <name> to restore alongside it`,
      );
    }
    if (restored) {
      const staged = await stageRestoreWorkspace(restored, opts.force);
      log.info(
        `restoring ${restored.bundle.bot} @ ${restored.bundle.stamp}: ` +
          `${String(staged.files)} entr(ies) -> ${restored.workspaceDir}`,
      );
    }
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
      // The box predates this agent, so the create-time skip never ran and it
      // may still carry a Portless web alias. Every URL producer prefers that
      // alias, so leaving it would keep publishing a name this daemon answers
      // with a 403.
      if (spec.service?.rejectsProxyHeaders === true && box.portlessAlias !== undefined) {
        log.info(
          `dropping the ${box.portlessAlias}.localhost alias — ${spec.id} refuses proxied requests`,
        );
        await portlessUnalias(box.portlessAlias).catch(() => false);
        await clearBoxPortlessWebAlias(box.id).catch(() => {});
        box = { ...box, portlessAlias: undefined, portlessUrl: undefined };
      }
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

      // A service agent's box hosts a daemon, so it is always-on by default —
      // derived from the registry row's `caps.surface`, exactly like the
      // config-volume isolation below, never from an agent id. `--no-persistent`
      // is the opt-out; `undefined` leaves the call to `box.persistent`.
      const persistent = resolveCreatePersistent({ spec, flag: opts.persistent });
      if (persistent ?? cfg.box.persistent) {
        // Refused off the provider NAME, before the provider module is loaded —
        // the same order `create` uses. A capped provider must say no, not fail
        // later or hand back the expendable box the user did not ask for.
        const { providerName } = resolveProviderChoice(cfg, { provider: opts.provider });
        const refusal = persistentRefusal(providerName);
        if (refusal) throw new Error(refusal);
      }

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
          ...(persistent !== undefined ? { persistent } : {}),
          limits: resolveLimits(cfg.box, {}),
          // No `agentConfig` isolate here: `create` derives it from
          // `caps.surface` (a service agent's config volume is always per-box),
          // so every caller gets it — this one, the hub's queue worker, the tray.
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

    // The identity goes in only once the service has come up on its own.
    //
    // That ordering is deliberate, not a convenience. `openclaw onboard` is a
    // `run_once: marker` task whose marker lives on the box ROOTFS, not in the
    // agent's config volume, so it runs on every fresh box no matter what the
    // volume holds — there is no "write the state in before onboard" that works.
    // Letting it run first, then replacing what it wrote, means the marker is
    // already down and onboard never touches the restored identity again, on
    // this boot or any later one.
    if (restored) {
      s.start(`restoring ${spec.id} state into ${box.name}`);
      try {
        await stopUnit(box, service.name);
        const r = await restoreStateIntoBox({ box, agent: spec.id, bundle: restored.bundle });
        cmdLog.write(`cleared ${String(r.clearedSidecars.length)} stale db sidecar(s)`);
        await withOwningHub(box, async (client) => {
          await client.restartService(box.id, service.name);
        });
        view = await waitForService(box, service.name, timeoutSeconds, (line) => {
          s.message(line);
          cmdLog.write(line);
        });
        s.stop(`${spec.id} restored from ${restored.bundle.bot} @ ${restored.bundle.stamp}`);
      } catch (err) {
        s.stop('restore failed');
        throw err;
      }
    }

    // Printed BEFORE the outro so the outro stays the one line a script greps
    // for the URL. The Control UI asks for the token on first load, so a launch
    // that prints only the URL sends the user straight back to the CLI.
    for (const f of await readServiceUrlFields(box, service.urlFields ?? [])) {
      log.info(`${f.label}: ${f.value}`);
    }
    const url = service.expose ? await resolveServiceUrl(box) : null;
    // A URL we cannot forward to is worse than no URL: the port is held by
    // something else, so it answers with the wrong thing rather than failing.
    const warning = url ? webProxyWarning(await readBoxStatus(box)) : null;
    if (warning) log.warn(warning);
    if (url) outro(`${spec.id} on ${box.name}: ${url}`);
    else outro(`${spec.id} on ${box.name}`);
  } catch (err) {
    cmdLog.write(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    handleLifecycleError(err);
  } finally {
    cmdLog.close();
  }
}
