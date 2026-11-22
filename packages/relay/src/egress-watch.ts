/**
 * `startEgressWatchLoop` — the relay-owned host egress-IP watcher.
 *
 * A hetzner/digitalocean box's firewall admits SSH only from the machines in
 * its per-device allowlist. When this host's egress IP changes (a network
 * move, a DHCP lease, a VPN), its entry goes stale and every connection
 * establish to those boxes fails until something repairs it. The CLI repairs
 * only at two establish sites (`recover`, the first attach connect), and the
 * box→host direction (a box's `git push` riding the host ControlMaster) has no
 * CLI wrapper at all. This loop closes the gap: it caches the last egress it
 * saw, re-detects on start and on a slow tick, and on a change asks each
 * running firewall-bearing box's backend to `repairReachability` once — which
 * replaces only this machine's entry, never another machine's.
 *
 * Gated on the fleet: each tick first reads `state.json`, and with no running
 * box on a firewall-bearing provider (a docker-only user, an idle laptop) it
 * returns before any egress probe or provider API call.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BoxRecord, CloudBackend } from '@agentbox/core';
import {
  FIREWALL_PROVIDERS,
  STATE_DIR,
  detectDeviceCidrs,
  ipv4Cidrs,
  readState,
} from '@agentbox/sandbox-core';
import { resolveCloudBackend } from './host-actions.js';

export { FIREWALL_PROVIDERS };

export const EGRESS_CACHE_FILE = join(STATE_DIR, 'egress-ip.json');

const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * What the watcher last saw: the egress, and per running box the IPv4 egress
 * its firewall was last confirmed to admit. Per box, not one global value, so
 * a box whose repair failed, or that was paused through the change, is still
 * repaired on a later tick.
 */
export interface EgressCache {
  cidrs: string[];
  /** boxId -> IPv4 egress key (`ipv4Cidrs(...).join(',')`) last verified. */
  boxes: Record<string, string>;
  detectedAt?: string;
}

export interface EgressWatchDeps {
  log: (line: string) => void;
  /** Injectable for tests; defaults to `readState().boxes`. */
  listBoxes?: () => Promise<BoxRecord[]>;
  /** Injectable for tests; defaults to the IPv4 (+ best-effort IPv6) detector. */
  detect?: () => Promise<string[]>;
  /** Injectable for tests; defaults to `resolveCloudBackend`. */
  resolveBackend?: (name: string) => Promise<CloudBackend>;
  /** Injectable for tests; default `~/.agentbox/egress-ip.json`. */
  readCache?: () => Promise<EgressCache | null>;
  writeCache?: (cache: EgressCache) => Promise<void>;
  intervalMs?: number;
}

export interface EgressWatchHandle {
  /** Run one tick now (tests; also what start does first). */
  tick: () => Promise<void>;
  /** Stop scheduling and await any in-flight tick. */
  stop: () => Promise<void>;
}

/**
 * Boxes whose firewall this host must keep itself in: on a firewall-bearing
 * provider, believed running (records predating `lastState` count), and not
 * `open` (already reachable from anywhere). Pure.
 */
export function selectFirewallBoxes(boxes: readonly BoxRecord[]): BoxRecord[] {
  return boxes.filter(
    (b) =>
      FIREWALL_PROVIDERS.has(b.provider ?? '') &&
      !!b.cloud?.sandboxId &&
      (b.cloud.lastState === undefined || b.cloud.lastState === 'running') &&
      b.cloud.inbound?.mode !== 'open',
  );
}

async function defaultReadCache(): Promise<EgressCache | null> {
  try {
    const raw = JSON.parse(await readFile(EGRESS_CACHE_FILE, 'utf8')) as Partial<EgressCache>;
    return {
      cidrs: Array.isArray(raw.cidrs) ? raw.cidrs.filter((c) => typeof c === 'string') : [],
      boxes: raw.boxes && typeof raw.boxes === 'object' ? raw.boxes : {},
    };
  } catch {
    return null;
  }
}

async function defaultWriteCache(cache: EgressCache): Promise<void> {
  await mkdir(dirname(EGRESS_CACHE_FILE), { recursive: true });
  const body: EgressCache = { ...cache, detectedAt: new Date().toISOString() };
  await writeFile(EGRESS_CACHE_FILE, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

export function startEgressWatchLoop(deps: EgressWatchDeps): EgressWatchHandle {
  const { log } = deps;
  const listBoxes = deps.listBoxes ?? (async () => (await readState()).boxes);
  const detect = deps.detect ?? (() => detectDeviceCidrs({ fresh: true }));
  const resolveBackend = deps.resolveBackend ?? resolveCloudBackend;
  const readCache = deps.readCache ?? defaultReadCache;
  const writeCache = deps.writeCache ?? defaultWriteCache;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  let ticking = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let lastProbeFailure: string | null = null;

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const boxes = selectFirewallBoxes(await listBoxes().catch(() => []));
      if (boxes.length === 0) return; // the fleet gate: no probe, no API call

      let cidrs: string[];
      try {
        cidrs = await detect();
        lastProbeFailure = null;
      } catch (err) {
        // Offline / captive portal: say so once, not every tick.
        const msg = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err);
        if (msg !== lastProbeFailure) log(`egress-watch: egress probe failed: ${msg}`);
        lastProbeFailure = msg;
        return;
      }
      // Only IPv4 decides: boxes are dialled on IPv4, and the IPv6 probe is
      // best-effort — a flaky miss must not look like a network change.
      const v4 = ipv4Cidrs(cidrs).join(',');
      const cache = (await readCache()) ?? { cidrs: [], boxes: {} };
      const stale = boxes.filter((b) => cache.boxes[b.id] !== v4);
      // Carry only boxes still running: a paused box re-verifies when it resumes.
      const verified: Record<string, string> = {};
      for (const b of boxes) {
        const v = cache.boxes[b.id];
        if (v === v4) verified[b.id] = v;
      }
      if (stale.length > 0) {
        log(
          `egress-watch: egress ${cidrs.join(', ')}; checking ${String(stale.length)} box firewall(s)`,
        );
      }
      const backends = new Map<string, CloudBackend | null>();
      for (const box of stale) {
        const name = box.provider as string;
        if (!backends.has(name)) {
          const resolved = await resolveBackend(name).catch(() => null);
          if (!resolved?.repairReachability) {
            // Left unverified (retried next tick); say why, once per tick.
            log(
              `egress-watch: no ${name} backend with firewall repair in this relay; skipping its boxes`,
            );
          }
          backends.set(name, resolved);
        }
        const backend = backends.get(name);
        if (!backend?.repairReachability) continue;
        try {
          const r = await backend.repairReachability({
            sandboxId: box.cloud?.sandboxId as string,
            ...(box.cloud?.inbound ? { inbound: box.cloud.inbound } : {}),
          });
          if (r.changed) log(`egress-watch: ${box.name}: ${r.detail ?? 'firewall updated'}`);
          verified[box.id] = v4;
        } catch (err) {
          // Left unverified, so the next tick retries it.
          log(
            `egress-watch: ${box.name}: repair failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const same =
        cache.cidrs.join(',') === cidrs.join(',') &&
        Object.keys(verified).length === Object.keys(cache.boxes).length &&
        Object.entries(verified).every(([k, v]) => cache.boxes[k] === v);
      if (!same) await writeCache({ cidrs, boxes: verified }).catch(() => undefined);
    } finally {
      ticking = false;
    }
  }
  const run = (): void => {
    inFlight = tick().catch((err: unknown) => {
      log(`egress-watch: tick failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();

  return {
    tick,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
