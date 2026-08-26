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
import {
  makeStore,
  FsCustodyStore,
  type Store,
  type CustodyStore,
} from '@agentbox/relay/control-plane';
import { setCloudBackendLoader, startRelayDaemon } from '@agentbox/relay/daemon';
import {
  controlPlaneDeployPath,
  readPreparedStateRaw,
  shortFingerprint,
  type ControlPlaneDeployRecord,
  type PreparedBaseSnapshot,
  AGENT_SYNC_SPECS,
  BOX_IMAGE_REGISTRY,
  registryRefForSha,
} from '@agentbox/sandbox-core';
import { createHubBackend } from './lib/hub-backend';
import { collectHostCarried } from './lib/host-carried';
import { configureHubGitCredentials } from './lib/git-auth';
import { cloudBackendLoader } from './lib/provider-importers';
import { PEER_LOOPBACK_HEADER, isLoopbackAddress } from './lib/peer';

const dev = process.env.NODE_ENV !== 'production';
const port = Number.parseInt(process.env.AGENTBOX_HUB_PORT ?? '8787', 10);
// Default bind is 0.0.0.0 so docker boxes reach the embedded relay via
// host.docker.internal (the localhost hub replaces the bare relay, which already
// binds wide). The bind host no longer implies the profile — the localhost hub
// binds wide yet stays the token gate — so the profile is defaulted independently.
const host = process.env.AGENTBOX_HUB_HOST ?? '0.0.0.0';

// Profile: localhost (lightweight token gate) unless explicitly set to hetzner/
// vercel (a control box; `hub setup`/`hub expose` write AGENTBOX_HUB_PROFILE=hetzner).
// Only the password profiles default AUTH=on — localhost is left unset so it can
// enter token mode (an explicit AGENTBOX_HUB_AUTH=off still disables all protection).
// `/admin/*` stays loopback-only by peer address regardless of bind host (the
// localhost hub sets no admin token → adminGateAllows fail-closes non-loopback).
process.env.AGENTBOX_HUB_PROFILE ??= 'localhost';
if (process.env.AGENTBOX_HUB_PROFILE !== 'localhost') process.env.AGENTBOX_HUB_AUTH ??= 'on';

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

/** Parse a positive-int env override; undefined (→ the relay's default) if unset or junk. */
function positiveIntFromEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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

  // Custody (agent creds / project secrets / box SSH keys). Wired unconditionally
  // now: the `/api/v1/custody` routes reach it through globalThis and serve in
  // BOTH modes (the plan's "same path local ⇄ remote" rule — a local hub's own
  // `credentials push`/`pull` must round-trip). The relay daemon's `/admin/custody`
  // wire still fail-closes 503 without an admin token, so a plain localhost hub
  // exposes custody ONLY over its token-gated `/api/v1`, never the admin wire.
  const adminToken = process.env.AGENTBOX_RELAY_ADMIN_TOKEN ?? '';
  const custody: CustodyStore = new FsCustodyStore();

  // `hub.gitAuth=gh`: make the stored GitHub token visible to git and `gh`
  // before anything can need it — the create worker clones with it, and the
  // relay's bundle path pushes with it. Must run before startRelayDaemon, whose
  // executor can service a git RPC as soon as it is listening.
  const gitAuth = await configureHubGitCredentials((line) =>
    process.stdout.write(`agentbox-hub: ${line}\n`),
  );
  if (gitAuth === 'no-token') {
    process.stdout.write(
      'agentbox-hub: no GitHub token stored — git push/clone will only work if a GitHub App is configured (hub.gitAuth=app)\n',
    );
  }

  // The relay resolves cloud backends (git push / download / gh pr head probe)
  // through an injected loader — its own bundle carries no provider packages and
  // the published hub ships no node_modules to resolve them from. Register before
  // startRelayDaemon: the keepalive loop memoizes a failed resolve per backend
  // name for the life of the process.
  setCloudBackendLoader(cloudBackendLoader);

  const daemon = await startRelayDaemon({
    port,
    host,
    // Omitted → the relay builds its in-memory store (the localhost default).
    store,
    custody,
    adminToken,
    // Custody carries project seed tars, which dwarf the relay's 1 MiB
    // control-plane body cap. Env-tunable so a control box with unusually large
    // untracked seeds can be raised without a rebuild (`relay.custodyMaxBodyBytes`
    // is the PC-side spelling; the hub reads its own env).
    custodyMaxBodyBytes: positiveIntFromEnv(process.env.AGENTBOX_CUSTODY_MAX_BODY_BYTES),
    // The streaming blob surface's own cap (`relay.custodyMaxBlobBytes`), which
    // governs `carry:` payloads rather than seed tars.
    custodyMaxBlobBytes: positiveIntFromEnv(process.env.AGENTBOX_CUSTODY_MAX_BLOB_BYTES),
    logger: (line) => process.stdout.write(`agentbox-hub: ${line}\n`),
    // Next parses req.url itself when parsedUrl is omitted.
    uiHandler: (req, res) => {
      // Stamp the loopback verdict for the peer-gated Next routes (custody
      // byte-read). We own the socket here, so req.socket.remoteAddress is the real
      // peer; STRIP any client-supplied copy first so a remote caller can't forge
      // "I'm loopback", then set it only when the peer truly is loopback. Absence
      // (the delete) means non-loopback — fail-closed. See lib/peer.ts.
      delete req.headers[PEER_LOOPBACK_HEADER];
      if (isLoopbackAddress(req.socket.remoteAddress)) {
        req.headers[PEER_LOOPBACK_HEADER] = '1';
      }
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
  // Payload-carrying prompt fan-out for the `/api/v1` prompt-stream route (the
  // attach footer). Reaches the relay handle's in-process subscribers/prompts/
  // notices through this seam so @agentbox/relay stays out of Next's bundle.
  globalThis.__AGENTBOX_HUB_PROMPTS = {
    subscribe: (boxId, listener) => daemon.handle.subscribers.addListener(boxId, listener),
    backlog: (boxId) => ({
      prompts: daemon.handle.prompts.forBox(boxId),
      notices: daemon.handle.notices.forBox(boxId),
      // Latest status snapshot, so an attaching footer renders the agent
      // activity + service count immediately instead of sitting on `unknown`
      // until the box's next heartbeat (up to 15s).
      status: daemon.handle.statusStore.get(boxId),
    }),
  };
  // On a control box (password profile) the always-on web UI + `/api/v1/approvals`
  // are a durable place to answer, so declare the hub the durable subscriber: a
  // host-action gate (git.push, cp, …) parks its confirm instead of auto-denying
  // when no wrapper is attached — the laptop-off case that is the whole point of a
  // control box. A plain local hub keeps floor 0 (auto-deny when nothing attached;
  // the user is present and an unattended local box shouldn't wedge forever).
  if (authMode() === 'password') daemon.handle.subscribers.setDurableFloor(1);
  // The custody store (agent creds / project seeds / bake records / box SSH keys),
  // for the Custody + project-Seed routes (list/read/write). Wired in both modes
  // now, so a localhost hub serves its own `/api/v1/custody` too. Shared via
  // globalThis (like the backend) so @agentbox/relay stays out of Next's bundle:
  // a route that constructed `new FsCustodyStore()` itself would ERR_MODULE_NOT_FOUND
  // on execa in the standalone build.
  globalThis.__AGENTBOX_HUB_CUSTODY = custody;
  // The blob route enforces the same cap the relay's own blob surface does, so a
  // payload can't sneak past by arriving on `/api/v1` instead of `/admin`.
  globalThis.__AGENTBOX_HUB_CUSTODY_MAX_BLOB_BYTES = positiveIntFromEnv(
    process.env.AGENTBOX_CUSTODY_MAX_BLOB_BYTES,
  );

  // System / Build facts for the /api/v1/system route, read from @agentbox/sandbox-core
  // HERE (the custom server's scope, outside Next's bundle) and handed across as plain
  // data. The route must not import @agentbox/sandbox-core itself — it depends on execa
  // (serverExternalPackages), and a route-level runtime import fails in the standalone
  // build the same way a bundled FsCustodyStore does.
  globalThis.__AGENTBOX_HUB_SYSTEM = {
    preparedBase(provider) {
      const base = (readPreparedStateRaw(provider) as PreparedBaseSnapshot | null)?.base;
      if (!base) return null;
      return {
        fingerprint: base.contextSha256 ? shortFingerprint(base.contextSha256) : undefined,
        cliVersion: base.cliVersion,
        bakedAt: base.createdAt,
        imageRef: base.imageRef != null ? String(base.imageRef) : undefined,
      };
    },
    deployRecord() {
      try {
        const rec = JSON.parse(
          readFileSync(controlPlaneDeployPath(), 'utf8'),
        ) as ControlPlaneDeployRecord;
        // Whitelist the non-sensitive fields (+ the build `source`); the SSH key dir,
        // server/firewall ids and admin CIDR are operational detail the route omits.
        return {
          source: rec.source ?? null,
          provider: rec.provider,
          url: rec.url,
          publicUrl: rec.publicUrl,
          tunnel: rec.tunnel,
          autostart: rec.autostart,
          port: rec.port,
          bind: rec.bind,
        };
      } catch {
        return null; // no deploy record on this machine (a plain hub)
      }
    },
    hostCarried: () => collectHostCarried(AGENT_SYNC_SPECS),
    boxImage() {
      // The facts an "why didn't it pull the prebuilt image?" investigation
      // needs, and which otherwise have to be reconstructed by hand from
      // docker-prepared.json + config + the registry: which of the two published
      // variants this host asks for, and the exact tag it resolves to.
      try {
        const base = (readPreparedStateRaw('docker') as PreparedBaseSnapshot | null)?.base;
        const sha = base?.contextSha256;
        return {
          registry: BOX_IMAGE_REGISTRY,
          pullTag: sha ? registryRefForSha(sha) : undefined,
          stampedFingerprint: sha ? shortFingerprint(sha) : undefined,
          imageRef: base?.imageRef != null ? String(base.imageRef) : undefined,
          bakedAt: base?.createdAt,
        };
      } catch {
        return null;
      }
    },
  };

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
    // Bound wide, but the token URL is for THIS machine — print a loopback host so
    // it's clickable (0.0.0.0 is not a usable address in a browser).
    const openHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    process.stdout.write(
      `agentbox-hub: open http://${openHost}:${String(port)}/?token=${process.env.AGENTBOX_HUB_TOKEN ?? ''}\n`,
    );
  }

  const shutdown = (signal: string): void => {
    process.stdout.write(`agentbox-hub: ${signal} — shutting down\n`);
    void (worker?.stop() ?? Promise.resolve()).finally(() =>
      daemon.stop().finally(() => process.exit(0)),
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `agentbox-hub: fatal ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
