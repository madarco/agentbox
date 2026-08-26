import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildExposedHubEnv, EXPOSED_HUB_PROFILE, parseEnvFileBody } from './hub-expose.js';
import { controlPlaneDeployPath, type ControlPlaneDeployRecord } from './ssh-config.js';
import { resolveStagedRuntimeRoot, RUNTIME_ROOT_ENV } from './runtime-root.js';
import {
  fetchHealthz,
  HUB_RELAY_PORT,
  killPid,
  pingHealthz,
  processAlive,
  resolveCliEntry,
  shouldReclaimForVersion,
  type HealthzBody,
} from './hub-process.js';
import {
  hubDockerContext,
  hubPortlessCurrent,
  hubPortlessSync,
  hubPortlessTeardown,
} from './hub-hooks.js';

/**
 * `agentbox hub` lifecycle. The hub is the embedded relay + Next UI in ONE
 * process on the relay port (8787) — a superset of the lean `agentbox-relay`.
 * The two are mutually exclusive on the port, so:
 *   - starting the hub reclaims any lean relay already holding 8787;
 *   - a running hub answers /healthz with `ui:true`, so the create path's
 *     `ensureRelay()` reuses it (it also sets AGENTBOX_CLI_ENTRY so the capability
 *     gate is satisfied and it's never reclaimed for that reason).
 *
 * Lives in `@agentbox/sandbox-core` (not `@agentbox/sandbox-docker`) so a
 * docker-free host can start / probe / stop the hub without importing docker
 * machinery. The two docker-side niceties it used to reach for directly — the
 * Portless friendly URL and the docker build context — come through the
 * `hub-hooks.ts` seam, which the CLI fills from the docker package at startup;
 * an unset hook degrades to the plain loopback URL / no docker context.
 *
 * Shares the low-level probes (fetchHealthz/pingHealthz/killPid/processAlive)
 * and the version-reclaim gate with `relay.ts` (both import them from
 * `hub-process.ts`); keeps its own pid/log/token files so its status is
 * independent of the lean relay's.
 */

const STATE_DIR = join(homedir(), '.agentbox');
const HUB_PID_FILE = join(STATE_DIR, 'hub.pid');
/** The lean relay's pidfile — cleared when the hub takes the port from a relay. */
const RELAY_PID_FILE = join(STATE_DIR, 'relay.pid');
const HUB_LOG_FILE = join(STATE_DIR, 'hub.log');
export const HUB_TOKEN_FILE = join(STATE_DIR, 'hub', 'token');
const PORT = HUB_RELAY_PORT;
// Bind wide (like the bare relay in relay.ts) so docker boxes can reach the hub's
// embedded relay at host.docker.internal:8787 for their box-initiated RPCs (git
// push/cp/download, and the /api/v1 prompt stream the attach footer subscribes to
// once approvals moved off the bare relay onto the hub). The profile stays
// `localhost` (token gate) — decoupled from the bind host in server.ts — so this
// is not the hetzner control-box profile. `/admin/*` remains loopback-only by
// peer address (the localhost hub sets no admin token, so adminGateAllows
// fail-closes non-loopback callers); the LAN-reachable surface is only the
// token-gated `/api/v1` + UI and the box-facing `/rpc` + `/events`, matching the
// bare relay this replaces. INVARIANT (plan Step 12): this wide bind is what the
// token-profile custody byte-read peer-gate (apps/hub/lib/peer.ts) protects — do
// not narrow it back to loopback without keeping that gate.
const HOST = '0.0.0.0';
// The address to advertise in URLs (status output, the `?token=` open URL) and to
// health-probe — the hub binds wide (HOST) but is reached from THIS machine over
// loopback; `0.0.0.0` is not a usable browser/client address.
const LOOPBACK_HOST = '127.0.0.1';

/** Minimum Node for the hub server (node:sqlite in password mode + Next 16). */
const NODE_MIN = { major: 22, minor: 5 };

export interface HubEndpoint {
  /** Base URL the browser opens (127.0.0.1:8787). */
  hostUrl: string;
  /** Full open URL including `?token=` when the token gate is on. */
  openUrl: string;
  port: number;
  /** The token gate secret, when auth is on (localhost token mode). */
  token: string | null;
}

export interface EnsureHubOptions {
  onLog?: (line: string) => void;
  /**
   * Effective `portless.enabled`. When not `false` (and Portless is installed on
   * a non-OrbStack host) the hub registers `https://agentbox.localhost`. Pass
   * `false` to force teardown. Undefined → register best-effort.
   */
  portlessEnabled?: boolean | undefined;
}

/** CP dir on this machine, holding deploy.json + control-plane.env. */
const CP_DIR = join(STATE_DIR, 'control-plane');

/**
 * Resolve the exposed-hub spawn env from `~/.agentbox/control-plane`, or null
 * when this machine isn't exposed. This is the seam that makes EVERY `ensureHub`
 * caller — `hub start`, `restart`, autostart, the post-update refresh — bring
 * the hub up in the SAME mode without any of them knowing about it: the flip
 * lives entirely in the on-disk record `agentbox hub expose` writes.
 *
 * Best-effort: a missing/partial record or env file → null (the plain localhost
 * hub). The hub itself fails closed on a genuinely missing secret.
 */
async function resolveExposedSpawn(): Promise<{
  env: Record<string, string>;
  profile: string;
} | null> {
  try {
    const record = JSON.parse(
      await readFile(controlPlaneDeployPath(), 'utf8'),
    ) as ControlPlaneDeployRecord;
    if (record.provider !== 'local') return null;
    const envBody = await readFile(join(CP_DIR, 'control-plane.env'), 'utf8').catch(() => '');
    const env = buildExposedHubEnv(record, parseEnvFileBody(envBody));
    return { env, profile: EXPOSED_HUB_PROFILE };
  } catch {
    return null;
  }
}

function nodeVersion(): { major: number; minor: number } {
  const [major, minor] = process.versions.node.split('.').map((n) => Number.parseInt(n, 10));
  return { major: major ?? 0, minor: minor ?? 0 };
}

/** Throw a clear error below the hub's Node floor (the CLI floor is lower). */
function assertNodeSupported(): void {
  const v = nodeVersion();
  if (v.major < NODE_MIN.major || (v.major === NODE_MIN.major && v.minor < NODE_MIN.minor)) {
    throw new Error(
      `agentbox hub needs Node >= ${NODE_MIN.major}.${NODE_MIN.minor} (running ${process.versions.node}). ` +
        'Upgrade Node, or run the lean relay with `agentbox relay start`.',
    );
  }
}

/**
 * Node flags for the hub spawn. `node:sqlite` (better-auth on the password
 * profile) is behind `--experimental-sqlite` on Node 22.5–23; unflagged on 24+.
 */
function nodeFlags(): string[] {
  const v = nodeVersion();
  return v.major < 24 ? ['--experimental-sqlite'] : [];
}

async function readPid(file: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(file, 'utf8')).trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function readToken(): Promise<string | null> {
  try {
    const t = (await readFile(HUB_TOKEN_FILE, 'utf8')).trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** The hub's token gate secret (`~/.agentbox/hub/token`), or null when unset. */
export function readHubToken(): Promise<string | null> {
  return readToken();
}

async function endpointFor(portlessUrl?: string): Promise<HubEndpoint> {
  const token = await readToken();
  // Prefer the friendly Portless URL when one is registered; else the loopback
  // (NOT the bind host — `http://0.0.0.0` is not a usable browser/client URL).
  const hostUrl = portlessUrl ?? `http://${LOOPBACK_HOST}:${String(PORT)}`;
  return {
    hostUrl,
    openUrl: token ? `${hostUrl}/?token=${token}` : hostUrl,
    port: PORT,
    token,
  };
}

/**
 * Locate the built hub server (`server.js`) the CLI spawns. Mirrors
 * relay.ts:resolveRelayBin. Layouts:
 *   0. env override: AGENTBOX_HUB_BIN
 *   1. bundled CLI: <root>/runtime/hub/apps/hub/server.js (sibling of dist/)
 *   2. workspace dev: <repo>/apps/hub/dist-standalone/apps/hub/server.js
 */
export function resolveHubServer(): string {
  const override = process.env.AGENTBOX_HUB_BIN;
  if (override && existsSync(override)) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'runtime', 'hub', 'apps', 'hub', 'server.js'),
    resolve(here, '..', '..', '..', 'apps', 'hub', 'dist-standalone', 'apps', 'hub', 'server.js'),
    resolve(here, '..', '..', 'apps', 'hub', 'dist-standalone', 'apps', 'hub', 'server.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    'could not locate the built hub server; run `pnpm --filter @agentbox/hub build:standalone` ' +
      `(dev), or set AGENTBOX_HUB_BIN. Tried:\n  ${candidates.join('\n  ')}`,
  );
}

/**
 * The env the hub child needs beyond `process.env` to find files its own bundle
 * doesn't carry.
 *
 * The hub bundle lives at `<cli>/runtime/hub/apps/hub`, three levels BELOW the
 * staged runtime root — and every provider is inlined into it. So each
 * self-relative lookup those providers do (`<self>/../runtime`,
 * `<self>/../../runtime`) misses the real `<cli>/runtime`, and the hub silently
 * degrades: cloud base fingerprints come back undefined (`baseStatus: unknown`
 * → "baked, unverified"), and custody bake adoption — which gates creates on a
 * control box — skips every shared record. A dev tree hides it by falling back
 * to the monorepo sources; an npm install has no such fallback. Handing over the
 * roots the CLI already resolved is the fix, same as the docker context below.
 *
 * The docker build context is supplied through the `hub-hooks.ts` seam (the CLI
 * installs its `BUILD_CONTEXT_DIR`); a docker-free host omits it. The runtime
 * root is marker-verified, and `resolveStagedRuntimeRoot` checks
 * `AGENTBOX_RUNTIME_ROOT` first, so an operator override propagates. When no
 * staged root exists (a workspace-only build) the key is OMITTED rather than set
 * to a path that doesn't resolve — it would otherwise sit ahead of the child's
 * own correct lookup.
 */
export function hubRuntimeEnv(
  opts: { dockerContext?: string; runtimeRoot?: string } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const dockerContext = opts.dockerContext ?? hubDockerContext();
  if (dockerContext) env.AGENTBOX_DOCKER_CONTEXT = dockerContext;
  const runtimeRoot =
    opts.runtimeRoot ??
    resolveStagedRuntimeRoot(dirname(fileURLToPath(import.meta.url)), 'docker/Dockerfile.box');
  if (runtimeRoot) env[RUNTIME_ROOT_ENV] = runtimeRoot;
  return env;
}

/** Kill whatever holds the port (a lean relay or a stale hub) and confirm it freed. */
async function reclaimPort(
  reportedPid: number | undefined,
  log: (line: string) => void,
): Promise<void> {
  const pidFromFile = await readPid(HUB_PID_FILE);
  const seen = new Set<number>();
  for (const pid of [reportedPid, pidFromFile]) {
    if (typeof pid !== 'number' || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    if (!(await processAlive(pid))) continue;
    log(`stopping process on :${String(PORT)} (pid ${String(pid)})`);
    await killPid(pid);
  }
  await unlink(HUB_PID_FILE).catch(() => {});
  // Same reason as the relay side: a stale sibling pidfile makes `relay status`
  // report a process this call just killed.
  await unlink(RELAY_PID_FILE).catch(() => {});
  if (await pingHealthz(300)) {
    throw new Error(
      `something is still listening on :${String(PORT)} and could not be stopped ` +
        `(reported pid ${String(reportedPid ?? 'unknown')}); kill it manually and retry`,
    );
  }
}

/**
 * Idempotently bring up the embedded hub on 8787. Reuses an already-running hub
 * (`ui:true`, version match); reclaims a lean relay or a version-mismatched hub
 * first. Best-effort like ensureRelay: failures throw.
 */
export async function ensureHub(opts: EnsureHubOptions = {}): Promise<HubEndpoint> {
  const log = opts.onLog ?? (() => {});
  assertNodeSupported();
  await mkdir(STATE_DIR, { recursive: true });

  // Exposed? Resolve the flip from disk so this call (whoever made it) brings the
  // hub up in the machine's configured mode. `desiredProfile` defaults to
  // `localhost` — a plain hub.
  const exposed = await resolveExposedSpawn();
  const desiredProfile = exposed?.profile ?? 'localhost';

  const currentVersion = process.env.AGENTBOX_CLI_VERSION;
  // A hub running in the wrong profile (a plain localhost hub while this machine
  // is exposed, or the reverse) must be reclaimed, not reused: the two differ in
  // bind, auth and the resident worker.
  const reusable = (h: HealthzBody): boolean =>
    h.ui === true &&
    !shouldReclaimForVersion(h, currentVersion) &&
    (h.profile ?? 'localhost') === desiredProfile;

  const health = await fetchHealthz(500);
  if (health !== null) {
    const profileMismatch = (health.profile ?? 'localhost') !== desiredProfile;
    if (reusable(health)) {
      return endpointFor(await hubPortlessSync(opts.portlessEnabled, PORT)); // a hub already runs here
    }
    log(
      profileMismatch
        ? `a hub in the ${health.profile ?? 'localhost'} profile holds :${String(PORT)} — reclaiming to run ${desiredProfile}`
        : health.ui === true
          ? 'a hub from a different agentbox version holds :8787 — reclaiming'
          : 'a lean relay holds :8787 — reclaiming to start the hub',
    );
    await reclaimPort(health.pid, log);
    // fall through to spawn
  } else {
    const pid = await readPid(HUB_PID_FILE);
    if (pid !== null && (await processAlive(pid))) {
      // A hub process exists but isn't answering /healthz yet — give startup a
      // beat before deciding it's wedged. It has to clear the SAME bar as an
      // already-answering hub above: a bare "it responds" accepted a plain
      // localhost hub (or a lean relay) on a machine whose record asks for the
      // exposed control-box profile, so the flip silently didn't happen.
      let late: HealthzBody | null = null;
      for (let i = 0; i < 10; i++) {
        late = await fetchHealthz(300);
        if (late !== null) break;
        await delay(200);
      }
      if (late !== null && reusable(late)) {
        return endpointFor(await hubPortlessSync(opts.portlessEnabled, PORT));
      }
      if (late !== null) {
        log(
          `a hub in the ${late.profile ?? 'localhost'} profile holds :${String(PORT)} — reclaiming to run ${desiredProfile}`,
        );
      }
      // Still unresponsive after ~2s: replace it rather than report a false
      // "running" for a hub that never came up.
      log(`hub pid ${String(pid)} alive but /healthz unresponsive — restarting it`);
      await reclaimPort(pid, log);
      // fall through to a fresh spawn
    } else if (pid !== null) {
      await unlink(HUB_PID_FILE).catch(() => {});
    }
  }

  const hubServer = resolveHubServer();
  const cliEntry = resolveCliEntry();
  if (cliEntry === null) {
    throw new Error(
      'cannot start the hub: agentbox CLI entry not found (is the build complete?). ' +
        'Set AGENTBOX_CLI_ENTRY to override.',
    );
  }
  if (exposed) log(`bringing the hub up exposed (${desiredProfile} profile, worker on)`);
  return spawnHub(hubServer, cliEntry, log, opts.portlessEnabled, exposed?.env);
}

async function spawnHub(
  hubServer: string,
  cliEntry: string,
  log: (line: string) => void,
  portlessEnabled: boolean | undefined,
  exposedEnv?: Record<string, string>,
): Promise<HubEndpoint> {
  const logFd = openSync(HUB_LOG_FILE, 'a');
  const child = spawn(process.execPath, [...nodeFlags(), hubServer], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      // The staged hub is a production Next build; force production so server.ts
      // takes the standalone path (dev mode would load webpack, which the
      // standalone build prunes).
      NODE_ENV: 'production',
      AGENTBOX_CLI_ENTRY: cliEntry,
      // The hub is the localhost profile (token gate). It binds 0.0.0.0 (see HOST)
      // so docker boxes reach its embedded relay via host.docker.internal; the
      // profile is set independently of the bind host in server.ts.
      AGENTBOX_HUB_HOST: HOST,
      // The hub bundle ships no staged build context of its own, so its
      // in-process freshness checks couldn't fingerprint (degrading to
      // 'unknown'). Hand it the CLI's resolved roots so hub-side fingerprints
      // match what the create/prepare workers compute. See hubRuntimeEnv.
      ...hubRuntimeEnv(),
      // `hub expose` overrides the above (bind 0.0.0.0, profile hetzner, auth,
      // worker, public URL, tokens). Empty/absent → the plain localhost hub.
      ...(exposedEnv ?? {}),
    },
  });
  child.unref();
  // Note when the child dies before it ever answers /healthz. The common cause is
  // a startup crash (e.g. a missing runtime dep) whose stack the child already
  // wrote to HUB_LOG_FILE — we surface that tail rather than making the user wait
  // out the full timeout and then go read the log by hand.
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('exit', (code, signal) => {
    exit = { code, signal };
  });
  if (typeof child.pid === 'number') {
    await writeFile(HUB_PID_FILE, String(child.pid), 'utf8');
    log(`spawned hub process (pid ${String(child.pid)}, port ${String(PORT)})`);
  }
  // Next prepare takes a beat longer than the lean relay; give it ~25s.
  for (let i = 0; i < 50; i++) {
    if (await pingHealthz(300)) {
      log(`hub reachable on http://${LOOPBACK_HOST}:${String(PORT)}`);
      const purl = await hubPortlessSync(portlessEnabled, PORT);
      if (purl) log(`hub also reachable on ${purl}`);
      return endpointFor(purl);
    }
    if (exit !== null) {
      await unlink(HUB_PID_FILE).catch(() => {});
      // Let the child flush its last stderr line into the log before we tail it.
      await delay(150);
      throw new Error(
        await hubStartupError(`hub process exited (${describeExit(exit)}) during startup`),
      );
    }
    await delay(200);
  }
  throw new Error(
    await hubStartupError(
      `hub did not become reachable on http://${LOOPBACK_HOST}:${String(PORT)} within ~25s`,
    ),
  );
}

function describeExit(exit: { code: number | null; signal: NodeJS.Signals | null }): string {
  if (exit.signal !== null) return `killed by ${exit.signal}`;
  return `exit code ${String(exit.code ?? 'unknown')}`;
}

/** Build a startup-failure message with the tail of the hub log inlined. */
async function hubStartupError(headline: string): Promise<string> {
  const tail = await tailFile(HUB_LOG_FILE, 20);
  const suffix = tail
    ? `\n--- last lines of ${HUB_LOG_FILE} ---\n${tail}`
    : `; see ${HUB_LOG_FILE}`;
  return `${headline}${suffix}`;
}

/** Last `maxLines` non-empty lines of a file, or '' when unreadable/empty. */
async function tailFile(file: string, maxLines: number): Promise<string> {
  try {
    const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim().length > 0);
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

export interface StopHubResult {
  stopped: boolean;
  pid: number | null;
}

/** Stop the hub process + clear its pidfile. SIGTERM then SIGKILL. Idempotent. */
export async function stopHub(): Promise<StopHubResult> {
  const pid = await readPid(HUB_PID_FILE);
  if (pid === null) {
    await hubPortlessTeardown();
    return { stopped: false, pid: null };
  }
  if (!(await processAlive(pid))) {
    await unlink(HUB_PID_FILE).catch(() => {});
    await hubPortlessTeardown();
    return { stopped: false, pid };
  }
  await killPid(pid);
  await unlink(HUB_PID_FILE).catch(() => {});
  await hubPortlessTeardown();
  return { stopped: true, pid };
}

export interface HubStatus {
  /** /healthz responded. */
  running: boolean;
  /** /healthz reported a delegated Next UI (vs a bare relay on the port). */
  ui: boolean;
  pid: number | null;
  pidAlive: boolean;
  port: number;
  hostUrl: string;
  openUrl: string;
  token: string | null;
  pidFile: string;
  logFile: string;
  /** The running hub's profile (`localhost` | `hetzner`). Absent on old hubs / a lean relay. */
  profile?: string;
  /** True when the resident create worker is running (exposed hub). */
  worker?: boolean;
  /**
   * The running hub predates the bundle it was spawned from — something rebuilt
   * `server.js` underneath it (a `pnpm build`, or `npm publish`, whose
   * `prepublishOnly` rebuilds the workspace). Its eagerly-loaded chunks are still
   * in memory, but the next LAZY `import()` resolves against the new
   * content-hashed filenames and dies with `Cannot find module 'dist-XXXX.js'`.
   * Only surfaces later, on whichever command first needs a lazy module.
   */
  staleBundle?: boolean;
}

/** Read-only snapshot of the hub's liveness (mirrors getRelayStatus). */
export async function getHubStatus(): Promise<HubStatus> {
  const pid = await readPid(HUB_PID_FILE);
  const pidAlive = pid !== null && (await processAlive(pid));
  const health = await fetchHealthz(300);
  const ep = await endpointFor((await hubPortlessCurrent()) ?? undefined);
  return {
    running: health !== null,
    ui: health?.ui === true,
    pid,
    pidAlive,
    port: PORT,
    hostUrl: ep.hostUrl,
    openUrl: ep.openUrl,
    token: ep.token,
    pidFile: HUB_PID_FILE,
    logFile: HUB_LOG_FILE,
    ...(health?.profile ? { profile: health.profile } : {}),
    ...(health?.worker ? { worker: true } : {}),
    ...((await bundleIsNewerThanHub(pid)) ? { staleBundle: true } : {}),
  };
}

/**
 * Whether `server.js` was rewritten after the running hub started. The hub writes
 * its pidfile at boot, so that file's mtime IS the process start time — no `ps`
 * shell-out, and it works the same for a published install as for a dev tree.
 * False whenever either side can't be read: this drives a warning, so an
 * unknown must not read as "stale".
 */
async function bundleIsNewerThanHub(pid: number | null): Promise<boolean> {
  if (pid === null) return false;
  try {
    const [startedAt, builtAt] = await Promise.all([
      stat(HUB_PID_FILE).then((st) => st.mtimeMs),
      stat(resolveHubServer()).then((st) => st.mtimeMs),
    ]);
    return builtAt > startedAt;
  } catch {
    return false;
  }
}
