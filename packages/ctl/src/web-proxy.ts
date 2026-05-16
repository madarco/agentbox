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
export class WebProxy {
  private server: Server | null = null;
  private target: number | null = null;

  constructor(
    private readonly listenPort: number = DEFAULT_LISTEN_PORT,
    private readonly logPath: string = DEFAULT_LOG,
  ) {}

  /**
   * Point :80 at `targetPort`. `null` tears the listener down. A no-op when the
   * target is unchanged so a config reload that doesn't touch `expose:` doesn't
   * drop in-flight connections.
   */
  reconfigure(targetPort: number | null): void {
    if (targetPort === this.target) return;
    this.target = targetPort;
    this.closeServer();
    if (targetPort === null) {
      void this.log(`forwarding disabled`);
      return;
    }
    this.listen(targetPort);
  }

  stop(): void {
    this.target = null;
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
      void this.log(`listen :${String(this.listenPort)} failed: ${err.message}`);
      this.server = null;
    });
    server.listen(this.listenPort, '0.0.0.0', () => {
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
