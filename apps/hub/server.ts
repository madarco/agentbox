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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import next from 'next';
import { makeStore, FsCustodyStore, type Store, type CustodyStore } from '@agentbox/relay/control-plane';
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

/**
 * Pick the relay's persisted-state backend.
 *
 * - An explicit RELAY_STORE_URL / POSTGRES_URL always wins (`postgres://…`, a
 *   `sqlite:` URL, or a bare path).
 * - The control box (hetzner profile) otherwise defaults to SQLite at
 *   `~/.agentbox/hub/store.db` — one always-on process on a small VPS has no
 *   reason to run a database container, and its registry/approvals/queue must
 *   still survive a restart.
 * - localhost stays on the in-memory store (returns undefined): the laptop relay
 *   is one process whose real box state lives with the providers, and the
 *   daemon's loops read the in-memory registry directly.
 */
async function resolveStore(storeDbPath: string): Promise<Store | undefined> {
  const spec =
    process.env.RELAY_STORE_URL ??
    process.env.POSTGRES_URL ??
    (process.env.AGENTBOX_HUB_PROFILE === 'hetzner' ? `sqlite:${storeDbPath}` : undefined);
  if (!spec) return undefined;
  const store = makeStore(spec);
  await store.migrate?.();
  return store;
}

async function main(): Promise<void> {
  // localhost: provision the token gate secret and hand it to the middleware via
  // env (unless auth is explicitly off). Do this before Next starts so the mode
  // is settled for the first request.
  const { authMode, STORE_DB_PATH } = await import('./lib/auth-config');
  if (process.env.AGENTBOX_HUB_PROFILE === 'localhost' && process.env.AGENTBOX_HUB_AUTH !== 'off') {
    const { ensureHubToken } = await import('./lib/hub-token');
    process.env.AGENTBOX_HUB_TOKEN = await ensureHubToken();
  }

  // Standalone build (`agentbox hub`): hand Next its precompiled config so the
  // full next() API skips loadConfig() + the webpack hook — output:'standalone'
  // prunes webpack, so without this next() dies on `next/dist/compiled/webpack`.
  // Dev (`tsx server.ts`) has no required-server-files.json → unaffected.
  const dir = import.meta.dirname;
  if (!dev) {
    const rsfPath = path.join(dir, '.next', 'required-server-files.json');
    if (existsSync(rsfPath)) {
      const rsf = JSON.parse(readFileSync(rsfPath, 'utf8')) as { config: unknown };
      process.env.__NEXT_PRIVATE_STANDALONE_CONFIG ??= JSON.stringify(rsf.config);
      // Next resolves distDir ('./.next') against cwd; the CLI spawns us with an
      // arbitrary cwd, so anchor it here (the standalone `server.js` does the same).
      process.chdir(dir);
    }
  }

  const app = next({ dev, dir, hostname: host, port });
  await app.prepare();
  const handle = app.getRequestHandler();

  const store = await resolveStore(STORE_DB_PATH);

  // Custody (agent creds / project secrets / box SSH keys) is served only when
  // an admin token is set — the hetzner control box. The dispatcher fail-closes
  // 503 without the token, so wiring the fs store unconditionally is safe: a
  // loginless localhost hub simply never serves the routes.
  const adminToken = process.env.AGENTBOX_RELAY_ADMIN_TOKEN ?? '';
  const custody: CustodyStore | undefined = adminToken.length > 0 ? new FsCustodyStore() : undefined;

  const daemon = await startRelayDaemon({
    port,
    host,
    // Omitted → the relay builds its in-memory store (the localhost default).
    store,
    custody,
    adminToken,
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

  // Resident create worker (control box). Gated on AGENTBOX_HUB_WORKER=on so the
  // localhost profile never starts it; runs in-process because SQLite is
  // single-writer (phase 1). Node-only module, dynamically imported so Next
  // never sees the provider/git graph.
  let worker: { stop: () => Promise<void> } | undefined;
  if (process.env.AGENTBOX_HUB_WORKER === 'on') {
    const { startHubWorker } = await import('./lib/hub-worker');
    worker = startHubWorker({
      store: daemon.handle.store,
      log: (line) => process.stdout.write(`agentbox-hub-worker: ${line}\n`),
      publicUrl: process.env.AGENTBOX_HUB_PUBLIC_URL,
      adminCidr: process.env.AGENTBOX_HUB_ADMIN_CIDR,
      mockCreate: process.env.AGENTBOX_HUB_WORKER_MOCK === '1',
    });
  }

  process.stdout.write(`agentbox-hub: listening on ${host}:${String(port)} (dev=${String(dev)})\n`);
  if (mode === 'token') {
    process.stdout.write(`agentbox-hub: open http://${host}:${String(port)}/?token=${process.env.AGENTBOX_HUB_TOKEN ?? ''}\n`);
  }

  const shutdown = (signal: string): void => {
    process.stdout.write(`agentbox-hub: ${signal} — shutting down\n`);
    void (worker?.stop() ?? Promise.resolve()).finally(() => daemon.stop().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`agentbox-hub: fatal ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
