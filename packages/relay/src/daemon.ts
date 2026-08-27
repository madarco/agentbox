import { startRelayServer, type RelayServerHandle, type RelayServerOptions } from './server.js';
import { startAutopauseLoop } from './autopause.js';
import { startCloudKeepaliveLoop } from './cloud-keepalive.js';
import { startQueueLoop } from './queue.js';
import { startRetentionLoop } from './retention.js';
import { HostReachPoller } from './host-reach-poller.js';
import { executeCloudAction, lookupCloudBoxOwner } from './host-actions.js';
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
  // With a control box configured, this relay is also the user's side of the
  // host-reach channel: it drains the `cp` actions the control box parked for
  // this machine and runs them against the real project files here.
  const controlPlaneUrl = (opts.controlPlaneUrl ?? process.env.AGENTBOX_CONTROL_PLANE_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const hostReachToken = (
    opts.hostReachAdminToken ??
    process.env.AGENTBOX_RELAY_ADMIN_TOKEN ??
    ''
  ).trim();
  // Never on the control box itself: it is the one parking the actions, and a
  // poller there would race the PC for work it cannot do.
  const hostReachPoller =
    controlPlaneUrl.length > 0 && hostReachToken.length > 0 && opts.controlPlane !== true
      ? new HostReachPoller({
          controlPlaneUrl,
          adminToken: hostReachToken,
          logger: log,
          execute: (action) =>
            executeHostReachAction(action, {
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
        'cp between a hub box and this machine will not reach it (re-run `agentbox hub setup`)',
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
  const queue = startQueueLoop({
    log,
    registry: handle.registry,
    statusStore: handle.statusStore,
    // Refresh the embedded hub UI whenever a background job flips state
    // (queued → running → done/failed), so a create job's box shows up and
    // then transitions creating → running without waiting for the 15s SSE ping.
    onStatusChange: () => handle.hubNotifier.notify(),
  });
  // Sweep answered prompts + finished create jobs on a resident control box
  // (durable store). A no-op when the store lacks the prune methods (localhost).
  const retention = startRetentionLoop({ store: handle.store, log });
  // `poke` isn't on the declared QueueLoopHandle (only `stop` is); same cast bin.ts used.
  handle.setQueuePoke(() => {
    (queue as { poke?: () => void }).poke?.();
  });

  return {
    handle,
    stop: async () => {
      await Promise.allSettled([
        autopause.stop(),
        cloudKeepalive.stop(),
        queue.stop(),
        retention.stop(),
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
 * real project path rather than the control box's idea of one.
 *
 * Resolving the box locally is also the authorization step: this machine only
 * acts for boxes it already knows. A box it has never adopted gets a result
 * telling the user how to adopt it, never a hang.
 */
async function executeHostReachAction(
  action: HostAction,
  deps: {
    prompts: RelayServerHandle['prompts'];
    subscribers: RelayServerHandle['subscribers'];
    log: (line: string) => void;
  },
): Promise<HostActionResult> {
  const owner = await lookupCloudBoxOwner(action.boxId);
  if (!owner) {
    return {
      exitCode: 69,
      stdout: '',
      stderr:
        `this machine has no record of box ${action.boxId}, so it cannot copy files for it.\n` +
        'Use the box here once — `agentbox ls` or `agentbox attach <box>` — to adopt it, then retry.\n',
    };
  }
  return executeCloudAction(action, {
    backendName: owner.backendName,
    boxId: action.boxId,
    boxName: owner.name,
    prompts: deps.prompts,
    subscribers: deps.subscribers,
    autoApproveSafeHostActions: owner.autoApproveSafeHostActions,
    log: deps.log,
  });
}
