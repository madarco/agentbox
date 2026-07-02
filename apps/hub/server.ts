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

// A non-loopback bind is the hetzner profile (better-auth password); loopback is
// localhost (lightweight token gate, set up below). Both are the same binary; the
// env flips the profile so lib/auth-config + proxy.ts agree. Only hetzner defaults
// AUTH=on — localhost is left unset so it can enter token mode (an explicit
// AGENTBOX_HUB_AUTH=off still disables all protection).
process.env.AGENTBOX_HUB_PROFILE ??= host === '127.0.0.1' ? 'localhost' : 'hetzner';
if (host !== '127.0.0.1') process.env.AGENTBOX_HUB_AUTH ??= 'on';

async function main(): Promise<void> {
  // localhost: provision the token gate secret and hand it to the middleware via
  // env (unless auth is explicitly off). Do this before Next starts so the mode
  // is settled for the first request.
  const { authMode } = await import('./lib/auth-config');
  if (process.env.AGENTBOX_HUB_PROFILE === 'localhost' && process.env.AGENTBOX_HUB_AUTH !== 'off') {
    const { ensureHubToken } = await import('./lib/hub-token');
    process.env.AGENTBOX_HUB_TOKEN = await ensureHubToken();
  }

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

  // Share the host backend (box list + lifecycle + approvals) and the live-update
  // notifier with Next server code via globalThis. The backend reads the relay
  // handle's in-process prompt map for approvals (block mode); the notifier drives
  // the /api/events SSE stream. __AGENTBOX_BOX_SOURCE (the Store) is kept for the
  // deferred poll-mode path only.
  globalThis.__AGENTBOX_BOX_SOURCE = daemon.handle.store;
  globalThis.__AGENTBOX_HUB_BACKEND = createHubBackend(daemon.handle);
  globalThis.__AGENTBOX_HUB_NOTIFIER = daemon.handle.hubNotifier;

  // Password profiles (hetzner/vercel): create/upgrade the auth tables and
  // env-seed the admin. Dynamic import so localhost never loads node:sqlite /
  // better-auth.
  const mode = authMode();
  if (mode === 'password') {
    const { ensureAuthReady } = await import('./lib/auth');
    await ensureAuthReady();
    process.stdout.write('agentbox-hub: auth ready\n');
  }

  process.stdout.write(`agentbox-hub: listening on ${host}:${String(port)} (dev=${String(dev)})\n`);
  if (mode === 'token') {
    process.stdout.write(`agentbox-hub: open http://${host}:${String(port)}/?token=${process.env.AGENTBOX_HUB_TOKEN ?? ''}\n`);
  }

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
