import { startRelayServer, type RelayServerHandle, type RelayServerOptions } from './server.js';
import { startAutopauseLoop } from './autopause.js';
import { startCloudKeepaliveLoop } from './cloud-keepalive.js';
import { startQueueLoop } from './queue.js';

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
export async function startRelayDaemon(opts: RelayServerOptions): Promise<RelayDaemonHandle> {
  const handle = await startRelayServer(opts);
  const log = opts.logger ?? (() => {});
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
  // `poke` isn't on the declared QueueLoopHandle (only `stop` is); same cast bin.ts used.
  handle.setQueuePoke(() => {
    (queue as { poke?: () => void }).poke?.();
  });

  return {
    handle,
    stop: async () => {
      await Promise.allSettled([autopause.stop(), cloudKeepalive.stop(), queue.stop()]);
      await handle.close();
    },
  };
}
