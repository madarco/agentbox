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

  if (await pingHealthz(500)) {
    return ENDPOINT;
  }

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

  const relayBin = resolveRelayBin();
  const logFd = openSync(LOG_FILE, 'a');
  // The relay shells out to this CLI entry for the checkpoint.create RPC
  // (it only knows the box id; the CLI resolves the rest). Resolve best-effort
  // — if not found the relay's handler reports a clear error.
  const cliEntry = resolveCliEntry();
  const child = spawn(
    process.execPath,
    [relayBin, 'serve', '--port', String(PORT), '--host', '0.0.0.0'],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        ...(cliEntry ? { AGENTBOX_CLI_ENTRY: cliEntry } : {}),
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
  throw new Error(
    `could not locate @agentbox/relay bin; tried:\n  ${candidates.join('\n  ')}`,
  );
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
  /** Docker container name; lets the relay `docker pause` the box for auto-pause. */
  containerName?: string;
  /** ISO-8601 box-creation time (BoxRecord.createdAt); auto-pause tie-break. */
  createdAt?: string;
  /**
   * Subset of BoxRecord.gitWorktrees the relay needs to dispatch git RPCs.
   * Empty/omitted for boxes without git repos.
   */
  worktrees?: GitWorktreeRecord[];
}

export async function registerBoxWithRelay(args: RegisterBoxArgs): Promise<void> {
  const worktrees: BoxWorktree[] = (args.worktrees ?? []).map((w) => ({
    containerPath: w.containerPath,
    hostMainRepo: w.hostMainRepo,
    branch: w.branch,
  }));
  await adminPost('/admin/register-box', {
    boxId: args.boxId,
    token: args.token,
    name: args.name,
    containerName: args.containerName,
    createdAt: args.createdAt,
    worktrees,
  });
}

export async function forgetBoxFromRelay(boxId: string): Promise<void> {
  try {
    await adminPost('/admin/forget-box', { boxId });
  } catch {
    // best-effort
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

export interface BoxWithToken {
  id: string;
  name: string;
  container?: string;
  createdAt?: string;
  relayToken?: string;
  gitWorktrees?: GitWorktreeRecord[];
}

/**
 * Re-push every known (id, token) to the relay's in-memory registry. Called
 * after `ensureRelay()` so a fresh / restarted relay learns about boxes that
 * were created in a previous CLI invocation.
 */
export async function rehydrateRelayRegistry(boxes: BoxWithToken[]): Promise<void> {
  for (const b of boxes) {
    if (!b.relayToken) continue;
    try {
      await registerBoxWithRelay({
        boxId: b.id,
        token: b.relayToken,
        name: b.name,
        containerName: b.container,
        createdAt: b.createdAt,
        worktrees: b.gitWorktrees,
      });
    } catch {
      // best-effort
    }
  }
}

export { RELAY_CONTAINER_NAME, RELAY_NETWORK_NAME, RELAY_IMAGE_REF, DEFAULT_RELAY_PORT };
