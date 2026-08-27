/**
 * Low-level process + `/healthz` probes shared by the host relay
 * (`@agentbox/sandbox-docker`'s `relay.ts`) and the hub lifecycle
 * (`hub-lifecycle.ts`). Pure node HTTP / signal / path helpers — none touch
 * docker — so they live in `@agentbox/sandbox-core`: a docker-free host that
 * only needs to start / probe the hub imports these, not the docker package.
 *
 * The relay and the embedded hub are mutually exclusive on the same port, so a
 * single `127.0.0.1:<relayPort()>` probe serves both.
 */
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { relayPort } from './relay-port.js';

export interface RelayReuseHealth {
  cliEntry?: boolean;
  version?: string;
}

/**
 * Decide whether an already-alive relay/hub must be reclaimed + respawned. Pure
 * (no fs/network) so it's unit-testable. Two independent gates, OR'd:
 *   - capability: `cliEntry === false` → it can't run cp/download/checkpoint and
 *     would 64 forever, so reclaim it.
 *   - version: both sides report a known non-empty version that DIFFERS → it was
 *     spawned by a different agentbox install (a stale npx cache entry, say) and
 *     must be replaced so its code matches the CLI.
 * Either version unknown → reuse (don't churn processes predating the field).
 * Match on VERSION only, never commit, so dev rebuilds ('0.0.0-dev' constant)
 * never cycle it every build.
 */
export function shouldReclaimForVersion(
  health: RelayReuseHealth,
  currentVersion: string | undefined,
): boolean {
  if (health.cliEntry === false) return true;
  if (
    typeof health.version === 'string' &&
    health.version.length > 0 &&
    typeof currentVersion === 'string' &&
    currentVersion.length > 0 &&
    health.version !== currentVersion
  ) {
    return true;
  }
  return false;
}

export async function processAlive(pid: number): Promise<boolean> {
  try {
    // Signal 0 is the existence probe: throws if no such process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM, wait for exit, then SIGKILL. */
export async function killPid(pid: number): Promise<void> {
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

/**
 * Raw TCP liveness on the relay/hub port, independent of what speaks HTTP there.
 *
 * The difference between this and {@link fetchHealthz} is the whole diagnostic:
 * TCP open + `/healthz` invalid means SOMETHING ELSE holds the port, which is
 * the case a relay that dies on EADDRINUSE needs to name.
 */
export function portIsOccupied(timeoutMs: number, port: number = relayPort()): Promise<boolean> {
  return new Promise<boolean>((resolveP) => {
    const sock = netConnect({ host: '127.0.0.1', port });
    const done = (occupied: boolean): void => {
      sock.destroy();
      resolveP(occupied);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

export function pingHealthz(timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolveP) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: relayPort(),
        method: 'GET',
        path: '/healthz',
        timeout: timeoutMs,
      },
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

export interface HealthzBody {
  ok: boolean;
  boxes: number;
  events: number;
  /** The relay's own pid (for reclaiming). Absent on relays predating this field. */
  pid?: number;
  /** True when a Next UI is delegated (the embedded hub) vs a bare relay. Absent on old relays. */
  ui?: boolean;
  /** Whether the relay has AGENTBOX_CLI_ENTRY (can run cp/download/checkpoint). Absent on old relays. */
  cliEntry?: boolean;
  /** The agentbox version that spawned the relay. Absent on relays predating this field. */
  version?: string;
  /** The agentbox short commit that spawned the relay (observability only). Absent on old relays. */
  commit?: string;
  /** The hub's profile (`localhost` | `hetzner` | `vercel`). Absent on a lean relay / old hubs. */
  profile?: string;
  /** True when the resident create worker is running (`hub expose`). Absent otherwise. */
  worker?: boolean;
}

export function fetchHealthz(timeoutMs: number): Promise<HealthzBody | null> {
  return new Promise<HealthzBody | null>((resolveP) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: relayPort(),
        method: 'GET',
        path: '/healthz',
        timeout: timeoutMs,
      },
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
                ui: typeof parsed.ui === 'boolean' ? parsed.ui : undefined,
                cliEntry: typeof parsed.cliEntry === 'boolean' ? parsed.cliEntry : undefined,
                version:
                  typeof parsed.version === 'string' && parsed.version.length > 0
                    ? parsed.version
                    : undefined,
                commit:
                  typeof parsed.commit === 'string' && parsed.commit.length > 0
                    ? parsed.commit
                    : undefined,
                profile:
                  typeof parsed.profile === 'string' && parsed.profile.length > 0
                    ? parsed.profile
                    : undefined,
                worker: parsed.worker === true ? true : undefined,
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

/**
 * Locate the agentbox CLI entry the relay/hub spawns for `checkpoint.create`
 * (and the hub child's `AGENTBOX_CLI_ENTRY`). Layouts:
 *   1. Bundled CLI (dev + published): this module IS bundled into the CLI entry,
 *      so the entry is `index.js` next to it.
 *   2. installed: `.../agentbox/node_modules/@agentbox/<pkg>/dist` next to
 *      `.../agentbox/dist/index.js`.
 * Best-effort: returns null when not found (the caller reports a clear error).
 */
export function resolveCliEntry(): string | null {
  const override = process.env.AGENTBOX_CLI_ENTRY;
  if (override && existsSync(override)) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, 'index.js'),
    resolve(here, '..', '..', '..', 'apps', 'cli', 'dist', 'index.js'),
    resolve(here, '..', '..', '..', '..', 'dist', 'index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
