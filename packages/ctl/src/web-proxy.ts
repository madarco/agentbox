import { appendFile } from 'node:fs/promises';
import { createServer, type Server, type Socket, connect } from 'node:net';

const DEFAULT_LISTEN_PORT = 80;
const DEFAULT_LOG = '/var/log/agentbox/web-proxy.log';

/**
 * In-process TCP forwarder the supervisor owns: container `listenPort` (80) ->
 * `127.0.0.1:<targetPort>` (the `expose:`-flagged service). Reconfigured by a
 * direct call on supervisor `init`/`reload`, so it tracks the config without a
 * second parser or polling. Binding :80 as the non-root `vscode` user works
 * because the image grants the node binary `cap_net_bind_service` (see
 * Dockerfile.box). Best-effort throughout — it must never throw into the
 * supervisor's lifecycle.
 */
/**
 * What the forwarder is currently doing, for the status snapshot.
 *
 * `error` is the whole reason this exists: a bind failure used to be a line in
 * a log file nobody reads, so a box whose :80 was already taken still reported
 * ready and still printed a URL — one that answered, wrongly, from whatever
 * else held the port.
 */
export interface WebProxyState {
  /** The container port the forwarder listens on. */
  port: number;
  /** The in-box service port it forwards to, or null when nothing is exposed. */
  target: number | null;
  /** Message from the last failed bind. Cleared by a bind that succeeds. */
  error?: string;
}

export class WebProxy {
  private server: Server | null = null;
  private target: number | null = null;
  private error: string | null = null;

  constructor(
    private readonly listenPort: number = DEFAULT_LISTEN_PORT,
    private readonly logPath: string = DEFAULT_LOG,
  ) {}

  /** Snapshot for the status reporter. */
  state(): WebProxyState {
    return {
      port: this.listenPort,
      target: this.target,
      ...(this.error === null ? {} : { error: this.error }),
    };
  }

  /**
   * Point :80 at `targetPort`. `null` tears the listener down. A no-op when the
   * target is unchanged so a config reload that doesn't touch `expose:` doesn't
   * drop in-flight connections.
   */
  reconfigure(targetPort: number | null): void {
    if (targetPort === this.target) return;
    this.target = targetPort;
    this.closeServer();
    // A new target gets a clean slate: the previous failure was about a bind
    // that is no longer being attempted.
    this.error = null;
    if (targetPort === null) {
      void this.log(`forwarding disabled`);
      return;
    }
    this.listen(targetPort);
  }

  stop(): void {
    this.target = null;
    this.error = null;
    this.closeServer();
  }

  private listen(targetPort: number): void {
    const server = createServer((client: Socket) => {
      const upstream = connect(targetPort, '127.0.0.1');
      // Either side erroring just tears the pair down — the upstream service
      // may not be listening yet (reload races service start); no crash.
      const kill = (): void => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', kill);
      upstream.on('error', kill);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.on('error', (err: Error) => {
      // Recorded, not just logged: `state()` carries it into the status
      // snapshot so the host can say the published URL will not work.
      this.error = `listen :${String(this.listenPort)} failed: ${err.message}`;
      void this.log(this.error);
      this.server = null;
    });
    server.listen(this.listenPort, '0.0.0.0', () => {
      this.error = null;
      void this.log(`:${String(this.listenPort)} -> 127.0.0.1:${String(targetPort)}`);
    });
    this.server = server;
  }

  private closeServer(): void {
    if (!this.server) return;
    this.server.close();
    this.server = null;
  }

  private async log(msg: string): Promise<void> {
    try {
      await appendFile(this.logPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // logging is best-effort; never let it surface
    }
  }
}
