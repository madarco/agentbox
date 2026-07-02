import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RELAY_PORT } from '@agentbox/relay';
import {
  fetchHealthz,
  killPid,
  pingHealthz,
  processAlive,
  resolveCliEntry,
  shouldReclaimForVersion,
} from './relay.js';

/**
 * `agentbox hub` lifecycle. The hub is the embedded relay + Next UI in ONE
 * process on the relay port (8787) — a superset of the lean `agentbox-relay`.
 * The two are mutually exclusive on the port, so:
 *   - starting the hub reclaims any lean relay already holding 8787;
 *   - a running hub answers /healthz with `ui:true`, so the create path's
 *     `ensureRelay()` reuses it (it also sets AGENTBOX_CLI_ENTRY so the capability
 *     gate is satisfied and it's never reclaimed for that reason).
 *
 * Shares the low-level probes (fetchHealthz/pingHealthz/killPid/processAlive) and
 * the version-reclaim gate with relay.ts; keeps its own pid/log files so its
 * status is independent of the lean relay's.
 */

const STATE_DIR = join(homedir(), '.agentbox');
const HUB_PID_FILE = join(STATE_DIR, 'hub.pid');
const HUB_LOG_FILE = join(STATE_DIR, 'hub.log');
const HUB_TOKEN_FILE = join(STATE_DIR, 'hub', 'token');
const PORT = DEFAULT_RELAY_PORT;
const HOST = '127.0.0.1';

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

async function endpointFor(): Promise<HubEndpoint> {
  const token = await readToken();
  const hostUrl = `http://${HOST}:${String(PORT)}`;
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

/** Kill whatever holds the port (a lean relay or a stale hub) and confirm it freed. */
async function reclaimPort(reportedPid: number | undefined, log: (line: string) => void): Promise<void> {
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

  const currentVersion = process.env.AGENTBOX_CLI_VERSION;
  const health = await fetchHealthz(500);
  if (health !== null) {
    if (health.ui === true && !shouldReclaimForVersion(health, currentVersion)) {
      return endpointFor(); // a hub already runs here
    }
    log(
      health.ui === true
        ? 'a hub from a different agentbox version holds :8787 — reclaiming'
        : 'a lean relay holds :8787 — reclaiming to start the hub',
    );
    await reclaimPort(health.pid, log);
    // fall through to spawn
  } else {
    const pid = await readPid(HUB_PID_FILE);
    if (pid !== null && (await processAlive(pid))) {
      for (let i = 0; i < 10; i++) {
        if (await pingHealthz(300)) return endpointFor();
        await delay(200);
      }
      log(`hub pid ${String(pid)} alive but /healthz unresponsive — proceeding`);
      return endpointFor();
    }
    if (pid !== null) await unlink(HUB_PID_FILE).catch(() => {});
  }

  const hubServer = resolveHubServer();
  const cliEntry = resolveCliEntry();
  if (cliEntry === null) {
    throw new Error(
      'cannot start the hub: agentbox CLI entry not found (is the build complete?). ' +
        'Set AGENTBOX_CLI_ENTRY to override.',
    );
  }
  return spawnHub(hubServer, cliEntry, log);
}

async function spawnHub(hubServer: string, cliEntry: string, log: (line: string) => void): Promise<HubEndpoint> {
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
      // The hub is the localhost profile (token gate); bind loopback.
      AGENTBOX_HUB_HOST: HOST,
    },
  });
  child.unref();
  if (typeof child.pid === 'number') {
    await writeFile(HUB_PID_FILE, String(child.pid), 'utf8');
    log(`spawned hub process (pid ${String(child.pid)}, port ${String(PORT)})`);
  }
  // Next prepare takes a beat longer than the lean relay; give it ~25s.
  for (let i = 0; i < 50; i++) {
    if (await pingHealthz(300)) {
      log(`hub reachable on http://${HOST}:${String(PORT)}`);
      return endpointFor();
    }
    await delay(200);
  }
  throw new Error(`hub did not become reachable on http://${HOST}:${String(PORT)} within ~25s; see ${HUB_LOG_FILE}`);
}

export interface StopHubResult {
  stopped: boolean;
  pid: number | null;
}

/** Stop the hub process + clear its pidfile. SIGTERM then SIGKILL. Idempotent. */
export async function stopHub(): Promise<StopHubResult> {
  const pid = await readPid(HUB_PID_FILE);
  if (pid === null) return { stopped: false, pid: null };
  if (!(await processAlive(pid))) {
    await unlink(HUB_PID_FILE).catch(() => {});
    return { stopped: false, pid };
  }
  await killPid(pid);
  await unlink(HUB_PID_FILE).catch(() => {});
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
}

/** Read-only snapshot of the hub's liveness (mirrors getRelayStatus). */
export async function getHubStatus(): Promise<HubStatus> {
  const pid = await readPid(HUB_PID_FILE);
  const pidAlive = pid !== null && (await processAlive(pid));
  const health = await fetchHealthz(300);
  const ep = await endpointFor();
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
  };
}
