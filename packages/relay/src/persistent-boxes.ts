/**
 * `startPersistentBoxLoop` — brings PERSISTENT boxes back up.
 *
 * A persistent box (`BoxRecord.persistent`, from `box.persistent` /
 * `--persistent`) is always-on: autopause never pauses it and the cloud
 * keepalive never lets it lapse. Neither covers the host going away — a reboot,
 * a docker daemon restart, or a laptop that slept through a cloud provider's own
 * stop leaves the box down with nothing to notice.
 *
 * So: on daemon start, and on a slow tick after that, every persistent box whose
 * `provider.probeState` is not `running` is brought back through the provider's
 * `reconnect` (`start` for a provider with no cheaper path).
 *
 * Not a docker `--restart` policy, which would be free: docker's own restart
 * brings the CONTAINER back and nothing else. `/workspace` is a bind of a git
 * worktree re-established by `startBox`'s `bindWorktrees`, which also launches
 * the ctl supervisor and dockerd and re-resolves the published host ports. A
 * docker-restarted container has an empty `/workspace`, no supervisor and a
 * stale port in its record.
 *
 * Failures are logged and retried on the next tick; the loop never throws and
 * never blocks the relay.
 */

import { pathToFileURL } from 'node:url';
import type { BoxRecord, BoxRuntimeState, Provider } from '@agentbox/core';
import { isSupportedApiVersion, pluginForProvider, readState } from '@agentbox/sandbox-core';
import { currentCloudBackendLoader } from './host-actions.js';

/** One persistent box's facts the pure selector reasons about. No I/O. */
export interface PersistentBoxEntry {
  boxId: string;
  name: string;
  provider: string;
  /** Live state from `provider.probeState`. */
  state: BoxRuntimeState;
}

/**
 * Pure selection: which persistent boxes need bringing back.
 *
 * `running` is already where we want it. `missing` means the underlying
 * container or sandbox is GONE — starting it is not possible and pretending
 * otherwise would just log a failure every tick; that box needs a human
 * (recreate, or drop the record). `stopped` and `paused` are recoverable.
 */
export function selectPersistentBoxesToStart(entries: PersistentBoxEntry[]): PersistentBoxEntry[] {
  return entries.filter((e) => e.state === 'stopped' || e.state === 'paused');
}

export interface PersistentBoxLoopDeps {
  log: (line: string) => void;
  /** Injectable for tests; defaults to the persistent boxes in `state.json`. */
  listPersistentBoxes?: () => Promise<BoxRecord[]>;
  /** Injectable for tests; defaults to the loader/bare-specifier resolution below. */
  resolveProvider?: (name: string) => Promise<Provider | null>;
  intervalMs?: number;
  /** Run the first reconcile immediately (default true — this IS the boot reconcile). */
  runOnStart?: boolean;
}

export interface PersistentBoxLoopHandle {
  /** Stop scheduling and await any in-flight tick. */
  stop: () => Promise<void>;
  /** Awaitable handle on the boot reconcile; tests use it, the daemon doesn't. */
  readonly firstTick: Promise<void>;
}

/**
 * Slow on purpose. Nothing here is latency-sensitive — the boot reconcile
 * (which runs immediately) covers the case that actually matters, and the tick
 * is only a safety net for a box that goes down later. Each tick costs one
 * provider probe per persistent box, and a cloud probe is an SDK round-trip.
 */
const DEFAULT_INTERVAL_MS = 5 * 60_000;

export function startPersistentBoxLoop(deps: PersistentBoxLoopDeps): PersistentBoxLoopHandle {
  const listPersistentBoxes = deps.listPersistentBoxes ?? defaultListPersistentBoxes;
  const resolveProvider = deps.resolveProvider ?? defaultResolveProvider;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const { log } = deps;

  // Providers resolved once per process (one dynamic import each).
  const providerCache = new Map<string, Provider | null>();
  // Boxes we already reported as unrecoverable (missing/destroyed) or whose
  // provider we could not resolve — logged once, not every tick.
  const reported = new Set<string>();

  let ticking = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function resolveCached(name: string): Promise<Provider | null> {
    if (providerCache.has(name)) return providerCache.get(name) ?? null;
    let provider: Provider | null = null;
    try {
      provider = await resolveProvider(name);
    } catch (err) {
      provider = null;
      log(
        `persistent: cannot resolve provider '${name}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    providerCache.set(name, provider);
    return provider;
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const boxes = await listPersistentBoxes();
      if (boxes.length === 0) return;

      const entries: { entry: PersistentBoxEntry; box: BoxRecord; provider: Provider }[] = [];
      for (const box of boxes) {
        const name = box.provider ?? 'docker';
        const provider = await resolveCached(name);
        if (!provider) {
          if (!reported.has(box.id)) {
            reported.add(box.id);
            log(`persistent: no provider '${name}' available for box ${box.name}; skipping`);
          }
          continue;
        }
        let state: PersistentBoxEntry['state'];
        try {
          state = await provider.probeState(box);
        } catch (err) {
          log(
            `persistent: probe of box ${box.name} (${name}) failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        if (state === 'missing') {
          if (!reported.has(box.id)) {
            reported.add(box.id);
            log(
              `persistent: box ${box.name} (${name}) is missing — its sandbox is gone, so it cannot be restarted (recreate it, or \`agentbox destroy ${box.name} --force\`)`,
            );
          }
          continue;
        }
        entries.push({
          entry: { boxId: box.id, name: box.name, provider: name, state },
          box,
          provider,
        });
      }

      const wanted = new Set(
        selectPersistentBoxesToStart(entries.map((e) => e.entry)).map((e) => e.boxId),
      );
      for (const { entry, box, provider } of entries) {
        if (!wanted.has(entry.boxId)) continue;
        try {
          log(`persistent: box ${entry.name} is ${entry.state}; bringing it back up`);
          // `reconnect` is the right verb: it unpauses a paused box and runs the
          // full start path (worktree binds, ctl/dockerd relaunch, port
          // re-resolution) for a stopped one. Providers all implement it.
          await provider.reconnect(box);
          reported.delete(entry.boxId);
          log(`persistent: box ${entry.name} is running again`);
        } catch (err) {
          log(
            `persistent: restarting box ${entry.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      // The loop must never crash the relay or stop scheduling.
      log(`persistent: tick error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      ticking = false;
    }
  }

  const firstTick = deps.runOnStart === false ? Promise.resolve() : tick();
  inFlight = firstTick;

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = tick();
  }, intervalMs);
  timer.unref();

  return {
    firstTick,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight.catch(() => {});
    },
  };
}

/** Every box in `state.json` whose record says `persistent`. */
async function defaultListPersistentBoxes(): Promise<BoxRecord[]> {
  try {
    const { boxes } = await readState();
    return boxes.filter((b) => b.persistent === true);
  } catch {
    return [];
  }
}

/**
 * Resolve a provider the same way `resolveCloudBackend` resolves a backend:
 * the injected host loader first (the CLI's `dist/cloud-backends.js`, the hub's
 * in-process map), then a bare-specifier import that only resolves in the dev
 * tree, then the plugin registry. Returns null rather than throwing — a box on a
 * provider this relay cannot load is skipped, not fatal.
 */
async function defaultResolveProvider(name: string): Promise<Provider | null> {
  const loader = currentCloudBackendLoader();
  if (loader?.resolveProvider) {
    const injected = await loader.resolveProvider(name);
    if (injected) return injected;
  }
  // Legacy fallback: computed specifier so esbuild leaves it alone (the relay
  // bundle carries no provider packages).
  const builtIn = [
    'docker',
    'daytona',
    'hetzner',
    'vercel',
    'e2b',
    'digitalocean',
    'remote-docker',
  ];
  if (builtIn.includes(name)) {
    const pkg = '@agentbox/sandbox-' + name;
    try {
      const mod = (await import(pkg)) as { providerModule?: { provider?: Provider } };
      return mod.providerModule?.provider ?? null;
    } catch {
      return null;
    }
  }
  const plugin = pluginForProvider(name);
  if (!plugin || !isSupportedApiVersion(plugin.apiVersion)) return null;
  try {
    const mod = (await import(pathToFileURL(plugin.resolvedEntry).href)) as {
      providerModule?: { provider?: Provider };
      providerModules?: { provider?: Provider }[];
    };
    const all = mod.providerModules ?? (mod.providerModule ? [mod.providerModule] : []);
    // Strict name match — never fall back to all[0] (wrong-provider hazard).
    return all.find((m) => m.provider?.name === name)?.provider ?? null;
  } catch {
    return null;
  }
}
