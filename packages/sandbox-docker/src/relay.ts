import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, openSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RELAY_PORT,
  RELAY_CONTAINER_NAME,
  RELAY_IMAGE_REF,
  RELAY_NETWORK_NAME,
  type BoxWorktree,
} from '@agentbox/relay';
import { containerExists, removeContainer } from './docker.js';
import type { GitWorktreeRecord } from './state.js';

const STATE_DIR = join(homedir(), '.agentbox');
const PID_FILE = join(STATE_DIR, 'relay.pid');
const LOG_FILE = join(STATE_DIR, 'relay.log');

export interface RelayEndpoint {
  /** URL boxes use to reach the relay from inside the container. */
  url: string;
  /** URL host-side processes (the CLI itself) use. */
  hostUrl: string;
  port: number;
}

const PORT = DEFAULT_RELAY_PORT;
const ENDPOINT: RelayEndpoint = {
  // host.docker.internal is the Docker Desktop / OrbStack-supplied alias for
  // the host's loopback as seen from inside a container. The corresponding
  // `--add-host=host.docker.internal:host-gateway` flag in runBox makes the
  // resolution work on Linux native Docker too.
  url: `http://host.docker.internal:${String(PORT)}`,
  hostUrl: `http://127.0.0.1:${String(PORT)}`,
  port: PORT,
};

export interface EnsureRelayOptions {
  onLog?: (line: string) => void;
}

/**
 * Idempotently bring up the host relay. Spawns the bundled `agentbox-relay`
 * bin as a detached node process bound to 0.0.0.0:8787 (so boxes can reach
 * it via host.docker.internal, and the CLI via 127.0.0.1). Best-effort:
 * failures throw and the caller treats it as "relay not reachable".
 *
 * If a legacy relay container from a previous version of agentbox is still
 * around, it's removed first so its bound DNS name doesn't shadow the new
 * host process for any old boxes that happen to still be running.
 */
export async function ensureRelay(opts: EnsureRelayOptions = {}): Promise<RelayEndpoint> {
  const log = opts.onLog ?? (() => {});
  await mkdir(STATE_DIR, { recursive: true });

  // Migration: kill the old in-docker relay if it's around. The host process
  // wants the same port; the container did NOT publish to host:8787, so there
  // is no actual port collision. We still remove it to avoid confusion (it'd
  // show up in `docker ps -a` forever otherwise).
  if (await containerExists(RELAY_CONTAINER_NAME)) {
    await removeContainer(RELAY_CONTAINER_NAME);
    log(`removed legacy relay container ${RELAY_CONTAINER_NAME}`);
  }

  const health = await fetchHealthz(500);
  if (health !== null) {
    // A relay is answering on the port. Only reuse it if it can actually run
    // host-side CLI actions. A relay spawned during a transient window where
    // the CLI dist didn't exist comes up without AGENTBOX_CLI_ENTRY and then
    // silently returns exit 64 for every cp/download/checkpoint for its whole
    // lifetime — and bare liveness can never detect that, so it's never
    // replaced. `cliEntry === false` (new relay, capability missing) → reclaim
    // and respawn. `cliEntry === undefined` (a relay from before this field
    // existed) is reused as before to avoid needlessly cycling old relays.
    if (health.cliEntry !== false) {
      return ENDPOINT;
    }
    log(
      'relay is alive but lacks AGENTBOX_CLI_ENTRY (cp/download/checkpoint would fail) — reclaiming',
    );
    await reclaimRelay(health.pid, log);
    // fall through to a fresh spawn below
  } else {
    const existingPid = await readPidFile();
    if (existingPid !== null && (await processAlive(existingPid))) {
      // Pid exists but healthz isn't responding yet — give it a beat to finish
      // startup. If it stays unresponsive, leave it alone (someone might be
      // debugging it) and let downstream POSTs fail as best-effort.
      for (let i = 0; i < 10; i++) {
        if (await pingHealthz(300)) return ENDPOINT;
        await delay(200);
      }
      log(`relay pid ${String(existingPid)} alive but /healthz unresponsive — proceeding anyway`);
      return ENDPOINT;
    }
    if (existingPid !== null) {
      await unlink(PID_FILE).catch(() => {});
    }
  }

  const relayBin = resolveRelayBin();
  // The relay shells back into this CLI entry for the cp / download /
  // checkpoint host actions (it only knows the box id; the CLI resolves the
  // rest). Resolve it BEFORE spawning and fail loud if missing: a relay
  // without it answers /healthz fine but 64s every such action, and the
  // capability gate above would just keep reclaiming + respawning it. A null
  // here almost always means the CLI dist is mid-rebuild — surface that
  // instead of producing a half-working relay.
  const cliEntry = resolveCliEntry();
  if (cliEntry === null) {
    throw new Error(
      'cannot start the host relay: agentbox CLI entry not found ' +
        '(is the build complete / dist present?). Set AGENTBOX_CLI_ENTRY to override.',
    );
  }
  return spawnRelay(relayBin, cliEntry, log);
}

/**
 * Stop a relay that's alive but missing AGENTBOX_CLI_ENTRY so a capable one
 * can take the port. Tries the pid the relay reported via /healthz first, then
 * the pidfile pid. Fails loud if the port is still held afterward — a silent
 * "couldn't reclaim" would just resurrect the original broken-relay bug.
 */
async function reclaimRelay(
  reportedPid: number | undefined,
  log: (line: string) => void,
): Promise<void> {
  const pidFromFile = await readPidFile();
  const seen = new Set<number>();
  for (const pid of [reportedPid, pidFromFile]) {
    if (typeof pid !== 'number' || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    if (!(await processAlive(pid))) continue;
    log(`stopping crippled relay pid ${String(pid)}`);
    await killPid(pid);
  }
  await unlink(PID_FILE).catch(() => {});
  // Confirm the port actually freed; if a relay still answers we'd reuse the
  // broken one again on the next call. Surface it rather than loop silently.
  if (await pingHealthz(300)) {
    throw new Error(
      `a relay without AGENTBOX_CLI_ENTRY is still listening on :${String(PORT)} and could not be ` +
        `stopped (reported pid ${String(reportedPid ?? 'unknown')}); kill it manually and retry`,
    );
  }
}

/** SIGTERM, wait for exit, then SIGKILL — same escalation as {@link stopRelay}. */
async function killPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // already gone
  }
  for (let i = 0; i < 20; i++) {
    if (!(await processAlive(pid))) return;
    await delay(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // best-effort
  }
}

/** Spawn the detached relay process wired with AGENTBOX_CLI_ENTRY, then wait for it to come up. */
async function spawnRelay(
  relayBin: string,
  cliEntry: string,
  log: (line: string) => void,
): Promise<RelayEndpoint> {
  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn(
    process.execPath,
    [relayBin, 'serve', '--port', String(PORT), '--host', '0.0.0.0'],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        AGENTBOX_CLI_ENTRY: cliEntry,
      },
    },
  );
  child.unref();
  if (typeof child.pid === 'number') {
    await writeFile(PID_FILE, String(child.pid), 'utf8');
    log(`spawned relay host process (pid ${String(child.pid)}, port ${String(PORT)})`);
  }

  for (let i = 0; i < 25; i++) {
    if (await pingHealthz(300)) {
      log(`relay reachable on ${ENDPOINT.hostUrl}`);
      return ENDPOINT;
    }
    await delay(200);
  }
  throw new Error(
    `relay did not become reachable on ${ENDPOINT.hostUrl} within 5s; see ${LOG_FILE}`,
  );
}

/**
 * Locate the `agentbox-relay` bin spawned as a child process. Layouts:
 *   0. env override: `AGENTBOX_RELAY_BIN`
 *   1. bundled CLI (dev + published `agent-box`): this module is bundled into
 *      the CLI at `<root>/dist/index.js`, the stage step puts the bin at
 *      `<root>/runtime/relay/bin.cjs` (sibling of dist/ in both layouts)
 *   2. legacy workspace: `<repo>/packages/sandbox-docker/dist` ↔ `<repo>/packages/relay/dist/bin.cjs`
 *   3. legacy externalized install: `<...>/node_modules/@agentbox/relay/dist/bin.cjs`
 */
function resolveRelayBin(): string {
  const override = process.env.AGENTBOX_RELAY_BIN;
  if (override && existsSync(override)) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'runtime', 'relay', 'bin.cjs'),
    resolve(here, '..', '..', 'relay', 'dist', 'bin.cjs'),
    resolve(here, '..', '..', '..', '@agentbox', 'relay', 'dist', 'bin.cjs'),
    resolve(here, '..', '..', 'node_modules', '@agentbox', 'relay', 'dist', 'bin.cjs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`could not locate @agentbox/relay bin; tried:\n  ${candidates.join('\n  ')}`);
}

/**
 * Locate the agentbox CLI entry the relay spawns for `checkpoint.create`.
 * Mirrors {@link resolveRelayBin}'s two layouts:
 *   1. workspace dev: `<repo>/packages/sandbox-docker/dist` ↔ `<repo>/apps/cli/dist/index.js`
 *   2. installed: `<...>/agentbox/node_modules/@agentbox/sandbox-docker/dist` ↔ `<...>/agentbox/dist/index.js`
 * Best-effort: returns null when not found (relay reports a clear error).
 */
function resolveCliEntry(): string | null {
  const override = process.env.AGENTBOX_CLI_ENTRY;
  if (override && existsSync(override)) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Bundled CLI (dev + published): this module IS bundled into the CLI
    // entry, so the entry is index.js next to this file.
    resolve(here, 'index.js'),
    resolve(here, '..', '..', '..', 'apps', 'cli', 'dist', 'index.js'),
    resolve(here, '..', '..', '..', '..', 'dist', 'index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export interface StopRelayResult {
  /** True when a live relay process was signalled (and the pidfile cleared). */
  stopped: boolean;
  /** The pid that was found in the pidfile, if any. */
  pid: number | null;
}

/**
 * Stop the host relay process and clear its pidfile. SIGTERM first, then
 * SIGKILL if it's still alive after a short grace period. Idempotent: a
 * missing/stale pidfile is not an error (returns `{ stopped: false }`).
 *
 * Used by `agentbox update` to reload the relay; the next box command brings
 * it back via {@link ensureRelay} (running the freshly-installed bin).
 */
export async function stopRelay(): Promise<StopRelayResult> {
  const pid = await readPidFile();
  if (pid === null) {
    return { stopped: false, pid: null };
  }
  if (!(await processAlive(pid))) {
    await unlink(PID_FILE).catch(() => {});
    return { stopped: false, pid };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone between the liveness check and the signal
  }
  for (let i = 0; i < 20; i++) {
    if (!(await processAlive(pid))) break;
    await delay(100);
  }
  if (await processAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // best-effort
    }
  }
  await unlink(PID_FILE).catch(() => {});
  return { stopped: true, pid };
}

export interface RelayStatus {
  /** True when /healthz responded with a 2xx. */
  running: boolean;
  /** Pidfile contents (null when missing/unparseable). */
  pid: number | null;
  /** Signal-0 probe on `pid` (false when `pid` is null). */
  pidAlive: boolean;
  /** Configured port (same value as endpoint.port). */
  port: number;
  /** URLs boxes / host-side callers use to reach the relay. */
  endpoint: RelayEndpoint;
  /** Parsed /healthz body; null when the relay isn't responding. */
  health: { boxes: number; events: number } | null;
  /** Absolute path to the pidfile. */
  pidFile: string;
  /** Absolute path to the process log. */
  logFile: string;
}

/**
 * Read-only snapshot of the host relay's liveness. Combines the two probes the
 * lifecycle code uses internally: pidfile + signal-0 + a short /healthz GET.
 * Three terminal states callers care about:
 *   - running: true                       — healthz ok
 *   - running: false, pidAlive: true      — zombie (process up, healthz silent)
 *   - running: false, pidAlive: false     — truly down
 */
export async function getRelayStatus(): Promise<RelayStatus> {
  const pid = await readPidFile();
  const pidAlive = pid !== null && (await processAlive(pid));
  const health = await fetchHealthz(300);
  return {
    running: health !== null,
    pid,
    pidAlive,
    port: PORT,
    endpoint: ENDPOINT,
    health: health === null ? null : { boxes: health.boxes, events: health.events },
    pidFile: PID_FILE,
    logFile: LOG_FILE,
  };
}

function pingHealthz(timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolveP) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: PORT, method: 'GET', path: '/healthz', timeout: timeoutMs },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolveP(status >= 200 && status < 300);
      },
    );
    req.on('error', () => resolveP(false));
    req.on('timeout', () => {
      req.destroy();
      resolveP(false);
    });
    req.end();
  });
}

interface HealthzBody {
  ok: boolean;
  boxes: number;
  events: number;
  /** The relay's own pid (for reclaiming). Absent on relays predating this field. */
  pid?: number;
  /** Whether the relay has AGENTBOX_CLI_ENTRY (can run cp/download/checkpoint). Absent on old relays. */
  cliEntry?: boolean;
}

function fetchHealthz(timeoutMs: number): Promise<HealthzBody | null> {
  return new Promise<HealthzBody | null>((resolveP) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: PORT, method: 'GET', path: '/healthz', timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          resolveP(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            ) as Partial<HealthzBody>;
            if (
              typeof parsed.ok === 'boolean' &&
              typeof parsed.boxes === 'number' &&
              typeof parsed.events === 'number'
            ) {
              resolveP({
                ok: parsed.ok,
                boxes: parsed.boxes,
                events: parsed.events,
                pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
                cliEntry: typeof parsed.cliEntry === 'boolean' ? parsed.cliEntry : undefined,
              });
            } else {
              resolveP(null);
            }
          } catch {
            resolveP(null);
          }
        });
        res.on('error', () => resolveP(null));
      },
    );
    req.on('error', () => resolveP(null));
    req.on('timeout', () => {
      req.destroy();
      resolveP(null);
    });
    req.end();
  });
}

async function readPidFile(): Promise<number | null> {
  try {
    const text = await readFile(PID_FILE, 'utf8');
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    // Signal 0 is the existence probe: throws if no such process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function generateRelayToken(): string {
  return randomBytes(32).toString('hex');
}

export interface RegisterBoxArgs {
  boxId: string;
  token: string;
  name: string;
  /**
   * Sandbox backend. Defaults to 'docker'. 'cloud' tells the host relay to
   * spawn a `CloudBoxPoller` for this box (which requires `previewUrl` +
   * `bridgeToken` to be set).
   */
  kind?: 'docker' | 'cloud';
  /**
   * For cloud boxes: which cloud backend to drive (e.g. 'daytona'). The
   * relay's executor lazy-imports `@agentbox/sandbox-{backend}` to do
   * host-only RPCs like git push.
   */
  backend?: string;
  /** Docker container name; lets the relay `docker pause` the box for auto-pause. */
  containerName?: string;
  /** ISO-8601 box-creation time (BoxRecord.createdAt); auto-pause tie-break. */
  createdAt?: string;
  /**
   * 1-based per-project box index. Forwarded so the relay's status-store
   * builds the same `<id>-<n>-<mnemonic>` dir segment the host's
   * `boxRunDirFor` uses. Absent for legacy boxes.
   */
  projectIndex?: number;
  /**
   * Subset of BoxRecord.gitWorktrees the relay needs to dispatch git RPCs.
   * Empty/omitted for boxes without git repos.
   */
  worktrees?: GitWorktreeRecord[];
  /** Required for `kind === 'cloud'`: preview URL of the in-sandbox relay's `/bridge/*`. */
  previewUrl?: string;
  /** Provider-proxy token for `previewUrl` (Daytona `x-daytona-preview-token`). */
  previewToken?: string;
  /** Required for `kind === 'cloud'`: bearer for the in-sandbox relay's `/bridge/*`. */
  bridgeToken?: string;
}

export async function registerBoxWithRelay(args: RegisterBoxArgs): Promise<void> {
  const worktrees: BoxWorktree[] = (args.worktrees ?? []).map((w) => ({
    containerPath: w.containerPath,
    hostMainRepo: w.hostMainRepo,
    branch: w.branch,
    gitWorktreePath: w.gitWorktreePath,
  }));
  await adminPost('/admin/register-box', {
    boxId: args.boxId,
    token: args.token,
    name: args.name,
    kind: args.kind ?? 'docker',
    backend: args.backend,
    containerName: args.containerName,
    createdAt: args.createdAt,
    projectIndex: args.projectIndex,
    worktrees,
    previewUrl: args.previewUrl,
    previewToken: args.previewToken,
    bridgeToken: args.bridgeToken,
  });
}

export async function forgetBoxFromRelay(boxId: string): Promise<void> {
  try {
    await adminPost('/admin/forget-box', { boxId });
  } catch {
    // best-effort
  }
}

/**
 * Best-effort: register an informational notice for a box so attached
 * `agentbox claude` footers / the dashboard show it (e.g. a spinner while a
 * checkpoint freezes the box). Returns the notice id, or null when the relay
 * is unreachable / too old to know the route — the caller treats a null id
 * as "nothing to clear later". Never throws: a missing notice must not fail
 * the operation it was decorating.
 */
export async function setRelayNotice(
  boxId: string,
  kind: string,
  message: string,
  ttlMs?: number,
): Promise<string | null> {
  try {
    const body = await adminPostForJson('/admin/notices/set', {
      boxId,
      kind,
      message,
      ...(typeof ttlMs === 'number' ? { ttlMs } : {}),
    });
    const id = (body as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Best-effort: clear a notice previously set via {@link setRelayNotice}. */
export async function clearRelayNotice(boxId: string, id: string): Promise<void> {
  try {
    await adminPost('/admin/notices/clear', { boxId, id });
  } catch {
    // best-effort
  }
}

/**
 * Mint a one-time host-initiated token from the host relay, scoped to
 * `(boxId, method, paramsHash)`. The caller passes the returned token to
 * `agentbox-ctl` via `--host-initiated-token`, which forwards it in the RPC
 * params; the relay re-hashes the incoming params and only skips the confirm
 * prompt on a full scope+hash match. Binding to paramsHash prevents a box
 * that harvests the token from agentbox-ctl's argv from replaying it with
 * mutated args (e.g. `--force` on push, modified `--title`/`--body` on PR).
 *
 * The endpoint is loopback-only, so the box cannot mint these directly. If
 * the relay is unreachable / too old to know the route, returns null and the
 * caller falls back to the wrapper-side prompt path.
 *
 * Pass `paramsHash: null` to opt out of params binding (no current call
 * sites do this; the host CLI always binds).
 */
export async function mintHostInitiatedToken(
  boxId: string,
  method: string,
  paramsHash: string | null,
  ttlMs?: number,
): Promise<string | null> {
  try {
    const body = await adminPostForJson('/admin/host-initiated/mint', {
      boxId,
      method,
      paramsHash,
      ...(typeof ttlMs === 'number' ? { ttlMs } : {}),
    });
    const token = (body as { token?: unknown } | null)?.token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function adminPost(path: string, body: unknown): Promise<void> {
  const json = JSON.stringify(body);
  await new Promise<void>((resolveP, rejectP) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        method: 'POST',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json).toString(),
        },
        timeout: 3000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolveP();
          } else {
            const text = Buffer.concat(chunks).toString('utf8');
            rejectP(new Error(`relay ${path} → ${String(status)}: ${text}`));
          }
        });
      },
    );
    req.on('error', rejectP);
    req.on('timeout', () => {
      req.destroy();
      rejectP(new Error(`relay ${path} timeout`));
    });
    req.write(json);
    req.end();
  });
}

/** Like {@link adminPost} but resolves with the parsed JSON response body. */
async function adminPostForJson(path: string, body: unknown): Promise<unknown> {
  const json = JSON.stringify(body);
  return new Promise<unknown>((resolveP, rejectP) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        method: 'POST',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json).toString(),
        },
        timeout: 3000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            rejectP(new Error(`relay ${path} → ${String(status)}`));
            return;
          }
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolveP(text.length > 0 ? JSON.parse(text) : {});
          } catch (err) {
            rejectP(err instanceof Error ? err : new Error(String(err)));
          }
        });
        res.on('error', rejectP);
      },
    );
    req.on('error', rejectP);
    req.on('timeout', () => {
      req.destroy();
      rejectP(new Error(`relay ${path} timeout`));
    });
    req.write(json);
    req.end();
  });
}

export interface BoxWithToken {
  id: string;
  name: string;
  /** Sandbox backend the box runs on. Defaults to 'docker' when absent. */
  provider?: 'docker' | 'cloud' | string;
  container?: string;
  createdAt?: string;
  relayToken?: string;
  projectIndex?: number;
  gitWorktrees?: GitWorktreeRecord[];
  /** Cloud-only: which backend (e.g. 'daytona') drives this box. */
  cloudBackend?: string;
  /** Cloud-only: in-sandbox /bridge URL + tokens (from BoxRecord.cloud). */
  relayPreviewUrl?: string;
  relayPreviewToken?: string;
  bridgeToken?: string;
}

/**
 * Re-push every known (id, token) to the relay's in-memory registry. Called
 * after `ensureRelay()` so a fresh / restarted relay learns about boxes that
 * were created in a previous CLI invocation — and, for cloud boxes,
 * restarts the host-side `CloudBoxPoller`.
 */
export async function rehydrateRelayRegistry(boxes: BoxWithToken[]): Promise<void> {
  for (const b of boxes) {
    if (!b.relayToken) continue;
    const kind = b.provider === 'docker' || b.provider === undefined ? 'docker' : 'cloud';
    try {
      await registerBoxWithRelay({
        boxId: b.id,
        token: b.relayToken,
        name: b.name,
        kind,
        backend: kind === 'cloud' ? b.cloudBackend : undefined,
        containerName: b.container,
        createdAt: b.createdAt,
        projectIndex: b.projectIndex,
        worktrees: b.gitWorktrees,
        previewUrl: b.relayPreviewUrl,
        previewToken: b.relayPreviewToken,
        bridgeToken: b.bridgeToken,
      });
    } catch {
      // best-effort
    }
  }
}

export { RELAY_CONTAINER_NAME, RELAY_NETWORK_NAME, RELAY_IMAGE_REF, DEFAULT_RELAY_PORT };
