import { checkoutEntriesFor, deviceTokenFor } from '@agentbox/sandbox-core';
import { loadEffectiveConfig, tryGetMachineId } from '@agentbox/config';
import { homedir } from 'node:os';
import { askPrompt } from './prompts.js';
import { executePcSkillsAction, isPcSkillsMethod } from './pc-skills.js';
import { createLlmProxyServer, llmProxyCredentialMatches, llmProxyHosts } from './llm-proxy.js';
import { startSkillLinkWatcher } from './skill-link-watch.js';
import { startRelayServer, type RelayServerHandle, type RelayServerOptions } from './server.js';
import { startAutopauseLoop } from './autopause.js';
import { startCloudKeepaliveLoop } from './cloud-keepalive.js';
import { startEgressWatchLoop } from './egress-watch.js';
import { startPersistentBoxLoop } from './persistent-boxes.js';
import { startQueueLoop } from './queue.js';
import { startRetentionLoop } from './retention.js';
import { HostReachPoller, type HostReachDecline } from './host-reach-poller.js';
import { mirrorHostReachPrompts, type HostReachPromptClient } from './host-reach-prompts.js';
import { HostSessionWatcher, defaultHostSinkResolver } from './history/host-watcher.js';
import { existsSync, realpathSync } from 'node:fs';
import { execa } from 'execa';
import { drainCpOutbox } from './cp-outbox-drain.js';
import { registrationAgents } from './registration-to-record.js';
import {
  boxWorkspacePath,
  cacheCpSources,
  executeCloudAction,
  lookupCloudBoxOwner,
  resolveHostPath,
  type CloudBoxOwner,
} from './host-actions.js';
import { normalizeCpParams, type CpMethod } from './cp-rpc.js';
import type { CpRpcParams } from './types.js';
import type { HostAction, HostActionResult } from './types.js';

// Re-exported here (not just from index.ts) so the two processes that own a
// relay — the CLI's `agentbox-relay serve` bin and the hub server — can register
// their built-in cloud backends from the same module they already import
// `startRelayDaemon` from, without pulling the full package barrel.
export {
  setCloudBackendLoader,
  type CloudBackendLoader,
  type CloudCpModule,
} from './host-actions.js';

export interface RelayDaemonOptions extends RelayServerOptions {
  /**
   * Control box this machine works with (`relay.controlPlaneUrl`). Set → the
   * daemon runs a {@link HostReachPoller} against it. Falls back to
   * `AGENTBOX_CONTROL_PLANE_URL`, which is how the CLI's `spawnRelay` passes it.
   */
  controlPlaneUrl?: string;
  /**
   * Bearer for that control box's `/admin/hostreach/*`. Falls back to
   * `AGENTBOX_RELAY_ADMIN_TOKEN`. Absent → no poller (logged, never silent).
   */
  hostReachAdminToken?: string;
  /**
   * Port of the LLM egress proxy (`llm.proxyPort`, llm-accounts Phase 7).
   * Absent → no proxy listener; the callers that own a real hub pass it.
   */
  llmProxyPort?: number;
}

export interface RelayDaemonHandle {
  /** The underlying relay server (url, store, close, …). */
  handle: RelayServerHandle;
  /** Stop the background loops, then close the server. */
  stop: () => Promise<void>;
}

/**
 * Boot the relay HTTP server plus its background loops (autopause / cloud
 * keepalive / queue) — the daemon that `agentbox-relay serve` runs. Extracted
 * so the hub server can import it, prepare Next, and pass Next's request
 * handler in as `opts.uiHandler` to serve the UI on the relay's own port.
 *
 * Process-owner concerns (the "listening" log line, SIGTERM/SIGINT handling)
 * stay with the caller so the same daemon works under both the relay bin and
 * the hub server.
 */
export async function startRelayDaemon(opts: RelayDaemonOptions): Promise<RelayDaemonHandle> {
  const handle = await startRelayServer(opts);
  const log = opts.logger ?? (() => {});
  const llmProxy =
    opts.llmProxyPort !== undefined
      ? await startLlmProxy(opts.llmProxyPort, opts.host ?? '0.0.0.0', handle, log)
      : null;
  // With a control box configured, this relay is also the user's side of the
  // host-reach channel: it drains the `cp` actions the control box parked for
  // this machine and runs them against the real project files here.
  const controlPlaneUrl = (opts.controlPlaneUrl ?? process.env.AGENTBOX_CONTROL_PLANE_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  // The shared admin token, or this PC's own device token for exactly this hub
  // (`agentbox hub login`), which the control box accepts on host-reach too.
  const hostReachToken = (
    opts.hostReachAdminToken ||
    process.env.AGENTBOX_RELAY_ADMIN_TOKEN ||
    (controlPlaneUrl ? deviceTokenFor(controlPlaneUrl) : '')
  ).trim();
  // Never on the control box itself: it is the one parking the actions, and a
  // poller there would race the PC for work it cannot do.
  const hostReachPoller =
    controlPlaneUrl.length > 0 && hostReachToken.length > 0 && opts.controlPlane !== true
      ? new HostReachPoller({
          controlPlaneUrl,
          adminToken: hostReachToken,
          logger: log,
          execute: (action, hub) =>
            executeHostReachAction(action, {
              prompts: handle.prompts,
              subscribers: handle.subscribers,
              log,
              cache: { controlPlaneUrl, adminToken: hostReachToken },
              hub,
            }),
          drainOutbox: () =>
            drainCpOutbox({
              controlPlaneUrl,
              adminToken: hostReachToken,
              prompts: handle.prompts,
              subscribers: handle.subscribers,
              log,
            }),
        })
      : null;
  hostReachPoller?.start();
  if (controlPlaneUrl.length > 0 && hostReachToken.length === 0 && opts.controlPlane !== true) {
    // Silence here would look exactly like "cp is broken again": the box's copy
    // falls back to the hub's cache (or fails) with nothing on this side saying why.
    log(
      'host-reach: a control box is configured but no admin token is available; ' +
        'cp between a hub box and this machine will not reach it (run `agentbox hub login`)',
    );
  }
  const autopause = startAutopauseLoop({
    registry: handle.registry,
    statusStore: handle.statusStore,
    events: handle.events,
    log,
  });
  const cloudKeepalive = startCloudKeepaliveLoop({
    registry: handle.registry,
    statusStore: handle.statusStore,
    log,
    // An idle pause must also silence that box's poller, or an auto-resuming
    // backend (e2b) revives the box on the poller's next long-poll.
    stopPoller: (boxId) => handle.stopCloudPoller(boxId),
  });
  // Keep this host in its hetzner/digitalocean boxes' firewalls across an
  // egress-IP change. Does nothing (no probe, no API call) without such a box.
  const egressWatch = startEgressWatchLoop({ log });
  // Boot reconcile for always-on boxes: a host reboot (or a provider-side stop)
  // leaves a persistent box down with nothing else to notice. Runs once
  // immediately, then on a slow tick.
  const persistentBoxes = startPersistentBoxLoop({ log });
  const queue = startQueueLoop({
    log,
    registry: handle.registry,
    statusStore: handle.statusStore,
    // Refresh the embedded hub UI whenever a background job flips state
    // (queued → running → done/failed), so a create job's box shows up and
    // then transitions creating → running without waiting for the 15s SSE ping.
    onStatusChange: () => handle.hubNotifier.notify(),
  });
  // Host sessions (agent-history Phase 5): opt-in, re-reads its config every
  // pass, so it is always constructed and idles until `history.hostSessions`.
  const hostSessions = new HostSessionWatcher({
    resolveSink: defaultHostSinkResolver({
      controlPlaneUrl,
      isControlBox: opts.controlPlane === true,
      ...(opts.history ? { local: opts.history } : {}),
    }),
    log,
  });
  hostSessions.start();
  // Sweep answered prompts + finished create jobs on a resident control box
  // (durable store). A no-op when the store lacks the prune methods (localhost).
  const retention = startRetentionLoop({ store: handle.store, log });
  // Linked skill folders are a PC's authoring loop; a control box has none.
  const skillLinks = opts.controlPlane === true ? null : startSkillLinkWatcher({ log });
  // `poke` isn't on the declared QueueLoopHandle (only `stop` is); same cast bin.ts used.
  handle.setQueuePoke(() => {
    (queue as { poke?: () => void }).poke?.();
  });

  return {
    handle,
    stop: async () => {
      llmProxy?.close();
      hostSessions.stop();
      await Promise.allSettled([
        autopause.stop(),
        cloudKeepalive.stop(),
        egressWatch.stop(),
        persistentBoxes.stop(),
        queue.stop(),
        retention.stop(),
        skillLinks?.stop() ?? Promise.resolve(),
        hostReachPoller?.stop() ?? Promise.resolve(),
      ]);
      await handle.close();
    },
  };
}

/**
 * Run one host-reach action on this machine, with this relay's own prompt
 * surfaces — so the confirm lands in the attach footer / local hub / tray of the
 * person whose files are about to move, and containment is judged against the
 * real project path rather than the control box's idea of one. The confirm is
 * also raised on the hub (`/api/v1/approvals`), so it can be answered from
 * wherever the owner is looking (see host-reach-prompts.ts).
 *
 * A ROUTED action (multi-PC Phase 4) names this machine's own checkout of the
 * box's repo in `route.folder`; host paths resolve against it, never against the
 * box record's workspace path (another machine's folder, or `/workspace` for a
 * box adopted from the hub). The hub only routes to this machine because the
 * checkouts registry says it has that repo, so a box this machine has no record
 * of is adopted from the hub (`agentbox hub adopt`) rather than refused.
 *
 * An unrouted action (a box from before routing) is served only for a box this
 * machine already knows, as before.
 */
export async function executeHostReachAction(
  action: HostAction,
  deps: {
    prompts: RelayServerHandle['prompts'];
    subscribers: RelayServerHandle['subscribers'];
    log: (line: string) => void;
    cache: { controlPlaneUrl: string; adminToken: string };
    hub?: HostReachPromptClient;
    /** Adopt a hub box into this machine's state (tests stub it). */
    adopt?: (boxId: string, cwd: string) => Promise<{ ok: boolean; error?: string }>;
    /** The repo key of a folder's origin, as this machine sees it (tests stub it). */
    repoKeyOf?: (folder: string) => Promise<string | undefined>;
    /** This machine's id (tests stub it). */
    machineId?: () => string | undefined;
  },
): Promise<HostActionResult | HostReachDecline> {
  if (isPcSkillsMethod(action.method)) return executePcSkillsReach(action, deps);
  const route = action.route;
  const repoKeyOf = deps.repoKeyOf ?? defaultRepoKeyOf;
  // A PC with its OWN record of the box, pointing at a real checkout of this
  // repo, serves from that: it is the folder the box was seeded from (or the
  // one this PC linked when it adopted it), which beats a registry row when
  // this machine holds several checkouts of the repo.
  const recordPath = route ? await boxWorkspacePath(action.boxId) : undefined;
  const recordOk =
    recordPath !== undefined &&
    existsSync(recordPath) &&
    (!route?.repoKey || (await repoKeyOf(recordPath)) === route.repoKey);
  const folder = recordOk ? undefined : route?.folder;
  if (folder !== undefined && !existsSync(folder)) {
    return {
      decline: `its checkout ${folder} is gone (run \`agentbox workspace rescan\` there to update the hub)`,
    };
  }
  // The folder decides what counts as "contained in the project" (and so what
  // auto-approves), so it is checked here rather than taken on the hub's word:
  // it must be a checkout of the very repo the action is routed for.
  if (folder !== undefined && route?.repoKey) {
    const key = await repoKeyOf(folder);
    if (key !== route.repoKey) {
      return {
        decline: `${folder} is not a checkout of ${route.repoKey} on this machine${key ? ` (its origin is ${key})` : ''}`,
      };
    }
  }
  // A PC serving only because it has the repo (not the box's origin) serves
  // paths inside that checkout and nothing else: it must never read or write
  // the rest of its own disk for someone else's box.
  const servingFolder = folder ?? (recordOk ? recordPath : undefined);
  if (route?.role === 'has-repo' && action.method.startsWith('cp.')) {
    const outside = servingFolder ? cpPathsOutside(action, servingFolder) : ['(no checkout)'];
    if (outside.length > 0) {
      return { decline: `${outside.join(', ')} is outside its checkout of the repo` };
    }
  }
  const owner: CloudBoxOwner | null = await lookupCloudBoxOwner(action.boxId);
  // A box this machine has no record of, routed here because it has the repo:
  // serve it with what the hub said about it, and adopt it (state.json record +
  // SSH keys from custody) only once the copy is approved — a denied or failed
  // copy leaves nothing behind.
  // This PC is the box's ORIGIN (it was created from here, e.g. through the
  // hub, and the record was never written): the box's own approval rules apply,
  // exactly as if the record existed. A fallback PC that merely has the repo
  // has no such standing, so it always asks.
  const isOrigin =
    route?.role === 'origin' &&
    route.box?.originMachineId !== undefined &&
    route.box.originMachineId === (deps.machineId ?? tryGetMachineId)();
  const routeAgents = route?.box ? registrationAgents(route.box) : undefined;
  const ephemeral =
    !owner && route && folder && route.box?.backend
      ? {
          name: route.box.name,
          backendName: route.box.backend,
          autoApproveSafeHostActions: isOrigin ? route.box.autoApproveSafeHostActions : false,
          // So `agents.list` answers for the box's own agent (a service agent's
          // units go only to a box that names it).
          ...(routeAgents ? { agents: routeAgents } : {}),
        }
      : null;
  if (!owner && !ephemeral) {
    // Not an answer, a refusal: another machine on this hub may hold the box,
    // and answering "unknown box" here would settle its user's copy. The hub
    // returns the action to the pool; if nobody claims it, its timers report it.
    deps.log(`host-reach: declining ${action.method} — box ${action.boxId} is not known here`);
    if (!route) return 'not-mine';
    return {
      decline: folder
        ? `box ${action.boxId} is not known here`
        : `no record of box ${action.boxId} and no checkout of its repo here`,
    };
  }
  const serve = (owner ?? ephemeral)!;
  const adopt = deps.adopt ?? adoptFromHub;
  const prepareBox = ephemeral
    ? async (): Promise<string | null> => {
        deps.log(`host-reach: adopting box ${action.boxId} from the hub to serve ${action.method}`);
        const adopted = await adopt(action.boxId, folder!);
        return adopted.ok
          ? null
          : `could not adopt box ${action.boxId} here: ${adopted.error ?? 'unknown error'}`;
      }
    : undefined;
  const unmirror = deps.hub
    ? mirrorHostReachPrompts({
        prompts: deps.prompts,
        subscribers: deps.subscribers,
        boxId: action.boxId,
        actionId: action.id,
        client: deps.hub,
        // The action's own confirm only: cp prompts carry its method, host-tool
        // prompts a `tool …` command.
        match: (ev) => {
          const command = ev.context?.command ?? '';
          return action.method.startsWith('tool.')
            ? command.startsWith('tool')
            : command === action.method;
        },
        log: deps.log,
      })
    : () => {};
  let result: HostActionResult;
  try {
    result = await executeCloudAction(action, {
      backendName: serve.backendName,
      boxId: action.boxId,
      boxName: serve.name,
      ...(folder ? { hostFolder: folder } : {}),
      ...(prepareBox ? { prepareBox } : {}),
      prompts: deps.prompts,
      subscribers: deps.subscribers,
      autoApproveSafeHostActions: serve.autoApproveSafeHostActions,
      ...(serve.agents ? { boxAgents: serve.agents } : {}),
      log: deps.log,
    });
  } finally {
    unmirror();
  }
  // File a copy with the control box so this same request answers when this
  // machine is offline. Strictly after the real copy succeeded, and awaited only
  // so the log lands in order — a failure here cannot change `result`.
  if (result.exitCode === 0 && action.method === 'cp.fromHost' && action.cachePrefix) {
    await cacheCpSources(
      action,
      action.cachePrefix,
      {
        controlPlaneUrl: deps.cache.controlPlaneUrl,
        adminToken: deps.cache.adminToken,
        logger: deps.log,
      },
      folder,
    );
  }
  return result;
}

/**
 * A `pcskills.*` action: about this machine's skill dirs, not a box. Served
 * only when routed (the hub names the device it means, so another PC never
 * answers for this one). Reading a skill out and writing one in ask the owner
 * here, mirrored to the hub's approvals like a `cp` confirm.
 */
async function executePcSkillsReach(
  action: HostAction,
  deps: Parameters<typeof executeHostReachAction>[1],
): Promise<HostActionResult | HostReachDecline> {
  if (!action.route) return { decline: 'a skills action must name the machine it is for' };
  if (!isPcSkillsMethod(action.method)) return 'not-mine';
  const maxBytes = await loadEffectiveConfig(homedir())
    .then((c) => c.effective.skills.maxSkillBytes)
    .catch(() => undefined);
  const unmirror = deps.hub
    ? mirrorHostReachPrompts({
        prompts: deps.prompts,
        subscribers: deps.subscribers,
        boxId: action.boxId,
        actionId: action.id,
        client: deps.hub,
        match: (ev) => ev.context?.command === action.method,
        log: deps.log,
      })
    : () => {};
  try {
    return await executePcSkillsAction(action.method, action.params, {
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      log: deps.log,
      confirm: async (p) => {
        const r = await askPrompt(
          deps.prompts,
          deps.subscribers,
          action.boxId,
          {
            kind: 'confirm',
            message: p.message,
            ...(p.detail ? { detail: p.detail } : {}),
            defaultAnswer: 'n',
            context: { command: p.command },
          },
          // Skills reach every box: never answered by a box's auto-approve.
          { noAutoApprove: true },
        );
        return r.answer === 'y' && r.cancelled !== true;
      },
    });
  } finally {
    unmirror();
  }
}

/**
 * The host paths of a cp action that fall outside `folder` once resolved (and
 * realpath'd where they exist, so a symlink out of the checkout counts as out).
 */
function cpPathsOutside(action: HostAction, folder: string): string[] {
  let norm: { sources: string[]; dest: string };
  try {
    norm = normalizeCpParams(action.method as CpMethod, action.params as CpRpcParams | undefined);
  } catch {
    return [];
  }
  const hostPaths = action.method === 'cp.toHost' ? [norm.dest] : norm.sources;
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const root = real(folder);
  return hostPaths.filter((p) => {
    const abs = real(resolveHostPath(folder, p));
    return abs !== root && !abs.startsWith(`${root.replace(/\/+$/, '')}/`);
  });
}

async function defaultRepoKeyOf(folder: string): Promise<string | undefined> {
  return (await checkoutEntriesFor([folder]))[0]?.repoKey;
}

/**
 * `agentbox hub adopt <box>` with `cwd` = this machine's checkout, so the new
 * record links to it. The CLI owns adoption (registration -> record, SSH keys
 * from custody); the relay only shells it, as it does for `cp` itself.
 */
async function adoptFromHub(boxId: string, cwd: string): Promise<{ ok: boolean; error?: string }> {
  const entry = process.env.AGENTBOX_CLI_ENTRY;
  if (!entry) return { ok: false, error: 'AGENTBOX_CLI_ENTRY not set' };
  const r = await execa(process.execPath, [entry, 'hub', 'adopt', boxId], {
    cwd,
    reject: false,
    timeout: 120_000,
  });
  if (r.exitCode === 0) return { ok: true };
  const why = (r.stderr || r.stdout || r.shortMessage || '').trim().split('\n').slice(-1)[0];
  return { ok: false, error: why || `exit ${String(r.exitCode)}` };
}

/**
 * Start the LLM CONNECT proxy next to the relay. Non-fatal: a taken port costs
 * the proxy (logged — a `forward` box's agent then fails with a 502 naming the
 * hub), never the relay.
 */
async function startLlmProxy(
  port: number,
  host: string,
  handle: RelayServerHandle,
  log: (msg: string) => void,
): Promise<{ close: () => void } | null> {
  const server = createLlmProxyServer({
    authorize: async (boxId, credential) => {
      const reg = await handle.store.getBox(boxId);
      return reg ? llmProxyCredentialMatches(reg.token, credential) : false;
    },
    allowedHosts: llmProxyHosts,
    log,
  });
  return new Promise((resolve) => {
    server.once('error', (err) => {
      log(`llm-proxy: not started on ${host}:${String(port)} (${err.message})`);
      resolve(null);
    });
    server.listen(port, host, () => {
      log(`llm-proxy: listening on ${host}:${String(port)}`);
      resolve({ close: () => server.close() });
    });
  });
}
