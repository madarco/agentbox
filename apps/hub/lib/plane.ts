import {
  GitHubAppLeaser,
  handleRelayRequest,
  loadGitHubAppConfig,
  PostgresStore,
  type ControlPlaneDeps,
} from '@agentbox/relay/control-plane';

/**
 * Build the control-plane deps once per server instance. On serverless this is
 * per warm instance (cheap to rebuild on a cold start); the Postgres pool is
 * created lazily inside PostgresStore on first query.
 */
let depsPromise: Promise<ControlPlaneDeps> | null = null;

function buildDeps(): Promise<ControlPlaneDeps> {
  const url = process.env.POSTGRES_URL ?? process.env.RELAY_STORE_URL;
  if (!url) throw new Error('control-plane: POSTGRES_URL (or RELAY_STORE_URL) is required');
  // A missing admin token is NOT fatal here — the handler fail-closes /admin/*
  // with a clean 503 (a freshly-deployed plane whose secrets aren't set yet is
  // "not ready", not broken). Only the DB is load-bearing for these deps.
  const adminToken = process.env.AGENTBOX_RELAY_ADMIN_TOKEN ?? '';
  const store = new PostgresStore({ connectionString: url });
  const appCfg = loadGitHubAppConfig();
  const leaser = appCfg ? new GitHubAppLeaser(appCfg) : null;
  // Which providers this plane can create boxes on. A serverless (Vercel) plane
  // sets this to the SDK-native set (no host execution) so it refuses hetzner;
  // a self-host plane with a worker leaves it unset (= all providers).
  const createProviders = (process.env.AGENTBOX_PLANE_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return store.migrate().then(() => ({
    store,
    leaser,
    adminToken,
    createProviders: createProviders.length > 0 ? createProviders : undefined,
    log: (line: string) => console.log(`[control-plane] ${line}`),
  }));
}

/**
 * Whether each secret is configured (for `/healthz`). Lets a freshly-deployed
 * plane report readiness before its env is set — used by the deploy flows to
 * tell "up but unconfigured" from "fully wired".
 */
function configuredFlags(): { db: boolean; app: boolean; admin: boolean } {
  return {
    db: !!(process.env.POSTGRES_URL ?? process.env.RELAY_STORE_URL),
    app: !!loadGitHubAppConfig(),
    admin: (process.env.AGENTBOX_RELAY_ADMIN_TOKEN ?? '').length > 0,
  };
}

/**
 * `/healthz` answers 200 regardless of configuration so a bare deploy (no
 * secrets yet) is reachable and never 500s. DB counts are best-effort.
 */
async function healthz(): Promise<Response> {
  const configured = configuredFlags();
  let boxes = 0;
  let events = 0;
  let db = false;
  if (configured.db) {
    try {
      const deps = await getDeps();
      boxes = await deps.store.countBoxes();
      events = await deps.store.countEvents();
      db = true;
    } catch {
      db = false; // DB unreachable / migrating — still report healthy-but-not-ready
    }
  }
  return Response.json(
    { ok: true, controlPlane: true, configured: { ...configured, db }, boxes, events },
    { status: 200 },
  );
}

function getDeps(): Promise<ControlPlaneDeps> {
  if (!depsPromise) {
    depsPromise = buildDeps().catch((err: unknown) => {
      // Reset so the next request retries the build (e.g. transient DB outage)
      // instead of caching a rejected promise forever.
      depsPromise = null;
      throw err;
    });
  }
  return depsPromise;
}

function bearerOf(request: Request): string {
  const raw = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1]!.trim() : '';
}

/** Adapt a Web Request → the relay core → a Web Response. */
export async function dispatch(request: Request): Promise<Response> {
  // healthz must work even with no secrets set (the deploy flows poll it on a
  // bare deploy before wiring env), so answer it before building the deps.
  const url0 = new URL(request.url);
  if (request.method === 'GET' && url0.pathname === '/healthz') {
    return healthz();
  }

  let deps: ControlPlaneDeps;
  try {
    deps = await getDeps();
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'control-plane misconfigured' },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const bodyText =
    request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  const res = await handleRelayRequest(
    {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      bearer: bearerOf(request),
      bodyText,
    },
    deps,
  );
  if (res.body === undefined || res.body === null) {
    return new Response(null, { status: res.status });
  }
  return Response.json(res.body, { status: res.status });
}
