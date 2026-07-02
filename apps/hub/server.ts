/**
 * AgentBox hub — custom server (localhost / hetzner profile).
 *
 * Prepares Next.js programmatically, then starts the relay daemon and hands
 * Next's request handler in as `uiHandler`. The relay owns the single node:http
 * server on the hub port (default 8787); every relay route (/healthz, /admin/*,
 * /rpc, /events, …) matches first, and any other request falls through to Next.
 * One process, one port, serves both the UI and the relay.
 *
 * Run with tsx: `tsx server.ts` (dev) or `NODE_ENV=production tsx server.ts`
 * (after `next build`). The standalone/`agentbox hub` bin packaging is Phase 5.
 */
import next from 'next';
import { startRelayDaemon } from '@agentbox/relay/daemon';
import { createHubBackend } from './lib/hub-backend';

const dev = process.env.NODE_ENV !== 'production';
const port = Number.parseInt(process.env.AGENTBOX_HUB_PORT ?? '8787', 10);
const host = process.env.AGENTBOX_HUB_HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const app = next({ dev, dir: import.meta.dirname, hostname: host, port });
  await app.prepare();
  const handle = app.getRequestHandler();

  const daemon = await startRelayDaemon({
    port,
    host,
    logger: (line) => process.stdout.write(`agentbox-hub: ${line}\n`),
    // Next parses req.url itself when parsedUrl is omitted.
    uiHandler: (req, res) => {
      void handle(req, res);
    },
  });

  // Share the relay's live Store (approvals view, Phase 4) and the host backend
  // (box list + lifecycle) with Next server code via globalThis.
  globalThis.__AGENTBOX_BOX_SOURCE = daemon.handle.store;
  globalThis.__AGENTBOX_HUB_BACKEND = createHubBackend();

  process.stdout.write(`agentbox-hub: listening on ${host}:${String(port)} (dev=${String(dev)})\n`);

  const shutdown = (signal: string): void => {
    process.stdout.write(`agentbox-hub: ${signal} — shutting down\n`);
    daemon.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`agentbox-hub: fatal ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
