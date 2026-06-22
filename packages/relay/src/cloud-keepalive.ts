/**
 * `startCloudKeepaliveLoop` — host-resident loop that renews a cloud box's
 * session-timeout while its in-box agent is active, so a long-running
 * Claude/Codex session isn't killed when the create-time timeout elapses.
 *
 * Sibling to `startAutopauseLoop` (and modeled on it): a host-wide sweep on a
 * timer that reads each box's live agent state from the `BoxStatusStore` and
 * acts. Where autopause *pauses* idle docker boxes, this *keeps alive* active
 * cloud boxes by pushing their death-time out to `lastActivity + window`. The
 * window REUSES the autopause idle threshold (`autopause.idleMinutes`) — per
 * the design, there is no separate keepalive knob; an idle box stops being
 * renewed once it's been quiet for the window and lapses at its current
 * deadline, mirroring autopause's idle semantics.
 *
 * The additive-vs-absolute SDK split (vercel `extendTimeout` adds to the
 * current deadline and can't read remaining; e2b `setTimeout` sets TTL from
 * now) is resolved here by tracking each box's intended deadline in memory and
 * handing the backend BOTH the absolute target and our tracked current
 * deadline. See `CloudBackend.renewTimeout`.
 *
 * Plan caps (vercel Hobby ~45m, Pro+ ~5h; e2b team plan) bound how far a box
 * can be extended — a renew past the cap throws and is swallowed here, so the
 * box lapses normally. The feature mainly benefits Pro+ plans, where the
 * conservative 45-min create default otherwise kills long sessions early.
 */

import { readFile } from 'node:fs/promises';
import {
  BUILT_IN_DEFAULTS,
  GLOBAL_CONFIG_FILE,
  parseUserConfig,
  type UserConfig,
} from '@agentbox/config';
import type { CloudBackend } from '@agentbox/core';
import { findBox, readState } from '@agentbox/sandbox-core';
import { loadAutopauseConfig, type AutopauseConfig } from './autopause.js';
import { resolveCloudBackend } from './host-actions.js';
import { readActiveAgent, type WorkingAgentState } from './queue.js';
import type { BoxRegistry } from './registry.js';
import type { BoxStatusStore } from './status-store.js';

/** Coarse activity for the renewal decision. `active` = keep the box alive. */
export type KeepaliveAgentState = 'active' | 'idle' | null;

/** One box's facts the pure selector reasons about. No I/O, no clock. */
export interface KeepaliveScanEntry {
  boxId: string;
  /** Cloud backend name, e.g. 'vercel'. */
  backend: string;
  /** Coarse activity across claude/codex/opencode, or null when no snapshot. */
  agentState: KeepaliveAgentState;
  /** epoch ms of the active agent's `updatedAt`, or null when no snapshot. */
  lastActivityMs: number | null;
}

export interface RenewDecision {
  boxId: string;
  backend: string;
  /** Absolute death-time we want this box held at: `lastActivity + window`. */
  targetDeadlineEpochMs: number;
}

/**
 * Pure selection: given each cloud box's activity facts, the window, and the
 * clock, return the boxes to renew with their target death-time. A box is
 * renewed while its agent is active, or while it has been idle for LESS than
 * the window (so a just-idle box keeps living a little, then lapses — the
 * "death = lastActivity + window" anchor the user asked for). Boxes with no
 * activity signal are skipped (let the create-time timeout govern); a wedged
 * agent (error/unknown) is never kept alive.
 *
 * The target is recomputed purely from `lastActivityMs + windowMs` every tick,
 * so it's deterministic and survives a relay restart (no persisted state).
 */
export function selectBoxesToRenew(
  entries: KeepaliveScanEntry[],
  windowMs: number,
  now: number,
): RenewDecision[] {
  const out: RenewDecision[] = [];
  for (const e of entries) {
    if (e.lastActivityMs == null || e.agentState == null) continue;
    const withinWindow = now - e.lastActivityMs < windowMs;
    if (e.agentState === 'active' || (e.agentState === 'idle' && withinWindow)) {
      out.push({
        boxId: e.boxId,
        backend: e.backend,
        targetDeadlineEpochMs: e.lastActivityMs + windowMs,
      });
    }
  }
  return out;
}

/**
 * Collapse the multi-agent `WorkingAgentState` into the coarse keepalive state.
 * Mirrors autopause's `coarsePauseState`, but here any live session expecting
 * attention (waiting/question/end-plan) counts as `active` so we never let it
 * be killed mid-interaction; only a settled `idle` is the lapse candidate.
 * error/unknown/null → null (don't keep a wedged or unknown box alive forever).
 */
function coarseKeepaliveState(s: WorkingAgentState | null): KeepaliveAgentState {
  switch (s) {
    case 'working':
    case 'compacting':
    case 'waiting':
    case 'question':
    case 'end-plan':
      return 'active';
    case 'idle':
      return 'idle';
    default:
      return null;
  }
}

export interface CloudKeepaliveLoopDeps {
  registry: BoxRegistry;
  statusStore: BoxStatusStore;
  log: (line: string) => void;
  /** Injectable for tests; defaults to the global autopause config loader. */
  loadConfig?: () => Promise<AutopauseConfig>;
  /** Injectable for tests; defaults to `resolveCloudBackend`. */
  resolveBackend?: (name: string) => Promise<CloudBackend>;
  /** Injectable for tests; defaults to the state.json sandboxId lookup. */
  lookupSandboxId?: (boxId: string) => Promise<string | null>;
  /** Injectable for tests; defaults to the global `box.vercelTimeoutMs`. */
  vercelCreateTimeoutMs?: () => Promise<number>;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  intervalMs?: number;
}

export interface CloudKeepaliveLoopHandle {
  /** Stop scheduling and await any in-flight tick. */
  stop: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 60_000;
/** e2b create-timeout seed (it has no config key; ignores the seed at call time). */
const E2B_CREATE_TIMEOUT_MS = 45 * 60_000;

export function startCloudKeepaliveLoop(
  deps: CloudKeepaliveLoopDeps,
): CloudKeepaliveLoopHandle {
  const loadConfig = deps.loadConfig ?? loadAutopauseConfig;
  const resolveBackend = deps.resolveBackend ?? resolveCloudBackend;
  const lookupSandboxId = deps.lookupSandboxId ?? defaultLookupSandboxId;
  const vercelCreateTimeoutMs = deps.vercelCreateTimeoutMs ?? defaultVercelCreateTimeoutMs;
  const nowFn = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const { registry, statusStore, log } = deps;

  // Per-box intended death-time we've pushed the session to. Seeded lazily from
  // `createdAt + create-timeout`; in-memory only — a relay restart re-seeds
  // (at worst one corrective over-extend, bounded by the plan cap).
  const tracked = new Map<string, number>();
  // Resolved backends cached across ticks (one dynamic import per provider).
  const backendCache = new Map<string, CloudBackend | null>();

  let ticking = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function resolveCached(name: string): Promise<CloudBackend | null> {
    if (backendCache.has(name)) return backendCache.get(name) ?? null;
    let backend: CloudBackend | null = null;
    try {
      backend = await resolveBackend(name);
    } catch {
      backend = null; // no executor for this backend — skip its boxes
    }
    backendCache.set(name, backend);
    return backend;
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled) return;
      const windowMs = cfg.idleMinutes * 60_000;
      const now = nowFn();

      const live = new Set<string>();
      const entries: KeepaliveScanEntry[] = [];
      const createdAt = new Map<string, string | undefined>();
      for (const reg of registry.list()) {
        if (reg.kind !== 'cloud' || !reg.backend) continue;
        const backend = await resolveCached(reg.backend);
        if (!backend || typeof backend.renewTimeout !== 'function') continue;
        live.add(reg.boxId);
        createdAt.set(reg.boxId, reg.createdAt);
        const active = readActiveAgent(statusStore.get(reg.boxId));
        entries.push({
          boxId: reg.boxId,
          backend: reg.backend,
          agentState: coarseKeepaliveState(active.state),
          lastActivityMs: active.updatedAt ? toEpoch(active.updatedAt) : null,
        });
      }

      // Drop tracking for boxes that are gone (destroyed / forgotten).
      for (const id of [...tracked.keys()]) if (!live.has(id)) tracked.delete(id);

      const decisions = selectBoxesToRenew(entries, windowMs, now);
      for (const d of decisions) {
        let current = tracked.get(d.boxId);
        if (current == null) {
          const createMs = toEpoch(createdAt.get(d.boxId)) ?? now;
          const createTimeoutMs =
            d.backend === 'vercel' ? await vercelCreateTimeoutMs() : E2B_CREATE_TIMEOUT_MS;
          current = createMs + createTimeoutMs;
          tracked.set(d.boxId, current);
        }
        // Only renew when the target meaningfully exceeds the tracked deadline,
        // so we don't churn the SDK for sub-tick gains or extend an idle box
        // that's still riding its create timeout.
        if (d.targetDeadlineEpochMs <= current + intervalMs) continue;
        try {
          const sandboxId = await lookupSandboxId(d.boxId);
          if (!sandboxId) continue;
          const backend = await resolveCached(d.backend);
          if (!backend?.renewTimeout) continue;
          await backend.renewTimeout({ sandboxId }, d.targetDeadlineEpochMs, current);
          tracked.set(d.boxId, d.targetDeadlineEpochMs);
          log(
            `cloud-keepalive: renewed box ${d.boxId} (${d.backend}) ` +
              `+${String(Math.round((d.targetDeadlineEpochMs - now) / 60_000))}m`,
          );
        } catch (err) {
          // Plan-cap rejection or a transient SDK error. Advance the tracked
          // deadline anyway so we don't hammer the cap every tick; a still-
          // active agent's later (higher) target will retry next tick.
          tracked.set(d.boxId, d.targetDeadlineEpochMs);
          const msg = err instanceof Error ? err.message : String(err);
          log(`cloud-keepalive: renew box ${d.boxId} (${d.backend}) failed: ${msg}`);
        }
      }
    } catch (err) {
      // The loop must never crash the relay or stop scheduling.
      const msg = err instanceof Error ? err.message : String(err);
      log(`cloud-keepalive: tick error: ${msg}`);
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = tick();
  }, intervalMs);
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight.catch(() => {});
    },
  };
}

function toEpoch(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Resolve a box's cloud sandboxId from `~/.agentbox/state.json`. */
async function defaultLookupSandboxId(boxId: string): Promise<string | null> {
  const state = await readState();
  const hit = findBox(boxId, state);
  if (hit.kind !== 'ok') return null;
  return hit.box.cloud?.sandboxId ?? null;
}

/**
 * Global `box.vercelTimeoutMs` — the create-time session timeout, used to seed
 * a vercel box's tracked deadline. Global-only (the relay is host-wide), falls
 * back to the built-in default. A close estimate is enough: the renew gate
 * tolerates seed drift, and an inaccurate seed self-corrects on the next renew.
 */
async function defaultVercelCreateTimeoutMs(): Promise<number> {
  const fallback = BUILT_IN_DEFAULTS.box.vercelTimeoutMs;
  try {
    const global: Partial<UserConfig> = parseUserConfig(
      await readFile(GLOBAL_CONFIG_FILE, 'utf8'),
      GLOBAL_CONFIG_FILE,
    );
    const v = global.box?.vercelTimeoutMs;
    return typeof v === 'number' && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}
