/**
 * `startCloudKeepaliveLoop` — host-resident loop that renews a cloud box's
 * session-timeout while its in-box agent is active, so a long-running
 * Claude/Codex session isn't killed when the create-time timeout elapses.
 *
 * Sibling to `startAutopauseLoop` (and modeled on it): a host-wide sweep on a
 * timer that reads each box's live agent state from the `BoxStatusStore` and
 * acts. Where autopause *pauses* idle docker boxes, this *keeps alive* active
 * cloud boxes by pushing their death-time out. The window REUSES the autopause
 * idle threshold (`autopause.idleMinutes`) — per the design, there is no
 * separate keepalive knob.
 *
 *   - active agent -> hold the death-time a full window ahead of NOW.
 *   - idle agent   -> let it lapse a window after it went idle, then stop.
 *
 * "Let it lapse" only works when the provider's timeout is an absolute deadline
 * (vercel, e2b). Daytona's is an INACTIVITY window that any request resets —
 * and this host polls every cloud box's preview URL continuously, so its clock
 * never runs out and an idle box would bill forever. For those backends
 * (`CloudBackend.timeoutModel === 'inactivity'`) the loop performs the stop
 * itself: see `selectBoxesToIdlePause`.
 *
 * The additive-vs-absolute SDK split (vercel `extendTimeout` adds to the
 * current deadline and can't read remaining; e2b `setTimeout` sets TTL from
 * now) is resolved by tracking each box's intended deadline in memory and
 * handing the backend BOTH the absolute target and our tracked current
 * deadline. See `CloudBackend.renewTimeout`. The tracked deadline is seeded
 * from the box's RECORDED effective create timeout (`cloud.sessionTimeoutMs`)
 * so a project/workspace override doesn't desync the seed.
 *
 * Plan caps (vercel Hobby ~45m, Pro+ ~5h; e2b team plan) bound how far a box
 * can be extended — a renew past the cap throws and is swallowed here, after
 * which the box is briefly backed off (so we don't hammer the API / log) and
 * lapses normally. The feature mainly benefits Pro+ plans, where the
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
import { findBox, readState, recordBox } from '@agentbox/sandbox-core';
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
  /** Absolute death-time we want this box held at. */
  targetDeadlineEpochMs: number;
}

/**
 * Pure selection: given each cloud box's activity facts, the window, and the
 * clock, return the boxes to renew with their target death-time.
 *
 *   - active agent  -> keep alive a full window from NOW (`now + windowMs`).
 *   - idle, < window since it went idle -> lapse `window` after it went idle
 *     (`lastActivityMs + windowMs`, where `lastActivityMs` is the fresh
 *     working->idle transition time).
 *   - idle >= window, no agent state, or a wedged agent (error/unknown) -> skip.
 *
 * The active case anchors on `now`, NOT on `lastActivityMs`, and does NOT
 * require `lastActivityMs`: the in-box status reporter bumps `updatedAt` on
 * state changes (per-tool-call), not during a long single `working` op (a
 * 30-min test run), so a stale/absent `updatedAt` must not freeze the target
 * below the tracked deadline — that would kill the box mid-work, the exact
 * failure this feature prevents. The idle case stays `now`-independent so an
 * idle box still lapses.
 */
export function selectBoxesToRenew(
  entries: KeepaliveScanEntry[],
  windowMs: number,
  now: number,
): RenewDecision[] {
  const out: RenewDecision[] = [];
  for (const e of entries) {
    if (e.agentState == null) continue;
    let target: number | null = null;
    if (e.agentState === 'active') {
      target = now + windowMs;
    } else if (
      e.agentState === 'idle' &&
      e.lastActivityMs != null &&
      now - e.lastActivityMs < windowMs
    ) {
      target = e.lastActivityMs + windowMs;
    }
    if (target != null) {
      out.push({ boxId: e.boxId, backend: e.backend, targetDeadlineEpochMs: target });
    }
  }
  return out;
}

/**
 * Pure selection: the boxes an `inactivity`-model backend would have stopped by
 * itself, had our own polling not kept resetting its idle clock (see
 * `CloudBackend.timeoutModel`). The host pauses these instead.
 *
 * Deliberately the exact complement of {@link selectBoxesToRenew}'s idle case:
 * that one renews an idle box until `lastActivity + window`, and this one takes
 * over from there. So a box is never both renewed and paused on the same tick.
 *
 * Only a box with a definite `idle` agent is a candidate. A box with no agent
 * state at all (`null` — a plain `agentbox shell` box, or one whose reporter
 * hasn't spoken yet) is left alone: we have no evidence it's unused, and an
 * attached human is exactly the case we must not pull the floor out from under.
 * An `active` agent (incl. waiting/question) is never a candidate.
 */
export function selectBoxesToIdlePause(
  entries: KeepaliveScanEntry[],
  windowMs: number,
  now: number,
): string[] {
  return entries
    .filter(
      (e) =>
        e.agentState === 'idle' &&
        e.lastActivityMs != null &&
        now - e.lastActivityMs >= windowMs,
    )
    .map((e) => e.boxId);
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

/** What the box-record lookup yields for seeding + the renew call. */
export interface CloudBoxLookup {
  sandboxId: string;
  /** Box creation time as epoch ms, or null when unparseable. */
  createdAtMs: number | null;
  /** Recorded effective create timeout (ms), or null when not recorded. */
  createTimeoutMs: number | null;
}

export interface CloudKeepaliveLoopDeps {
  registry: BoxRegistry;
  statusStore: BoxStatusStore;
  log: (line: string) => void;
  /** Injectable for tests; defaults to the global autopause config loader. */
  loadConfig?: () => Promise<AutopauseConfig>;
  /** Injectable for tests; defaults to `resolveCloudBackend`. */
  resolveBackend?: (name: string) => Promise<CloudBackend>;
  /** Injectable for tests; defaults to the state.json box lookup. */
  lookupBox?: (boxId: string) => Promise<CloudBoxLookup | null>;
  /** Injectable for tests; defaults to writing `cloud.lastState: 'paused'`. */
  persistPaused?: (boxId: string) => Promise<void>;
  /** Injectable for tests; fallback create timeout when a record lacks one. */
  fallbackCreateTimeoutMs?: (backend: string) => Promise<number>;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  intervalMs?: number;
}

export interface CloudKeepaliveLoopHandle {
  /** Stop scheduling and await any in-flight tick. */
  stop: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 60_000;
/** After a failed renew, skip the box for this long (avoid cap hammering / log spam). */
const FAILURE_BACKOFF_MS = 5 * 60_000;

export function startCloudKeepaliveLoop(
  deps: CloudKeepaliveLoopDeps,
): CloudKeepaliveLoopHandle {
  const loadConfig = deps.loadConfig ?? loadAutopauseConfig;
  const resolveBackend = deps.resolveBackend ?? resolveCloudBackend;
  const lookupBox = deps.lookupBox ?? defaultLookupBox;
  const persistPaused = deps.persistPaused ?? defaultPersistPaused;
  const fallbackCreateTimeoutMs = deps.fallbackCreateTimeoutMs ?? defaultFallbackCreateTimeoutMs;
  const nowFn = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const { registry, statusStore, log } = deps;

  // Per-box intended death-time we've pushed the session to. Seeded lazily from
  // the recorded `createdAt + create-timeout`; in-memory only — a relay restart
  // re-seeds (at worst one corrective over-extend, bounded by the plan cap).
  const tracked = new Map<string, number>();
  // Per-box "don't attempt before" time, set after a failed renew.
  const backoffUntil = new Map<string, number>();
  // Boxes we idle-paused, keyed by the `lastActivityMs` they had when we did.
  // A paused box keeps reporting that same idle snapshot, so without this it
  // would re-qualify for pausing on every tick.
  const idlePaused = new Map<string, number | null>();
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
      for (const reg of registry.list()) {
        if (reg.kind !== 'cloud' || !reg.backend) continue;
        const backend = await resolveCached(reg.backend);
        if (!backend || typeof backend.renewTimeout !== 'function') continue;
        live.add(reg.boxId);
        const active = readActiveAgent(statusStore.get(reg.boxId));
        entries.push({
          boxId: reg.boxId,
          backend: reg.backend,
          agentState: coarseKeepaliveState(active.state),
          lastActivityMs: active.updatedAt ? toEpoch(active.updatedAt) : null,
        });
      }

      // Drop per-box state for boxes that are gone (destroyed / forgotten).
      for (const id of [...tracked.keys()]) if (!live.has(id)) tracked.delete(id);
      for (const id of [...backoffUntil.keys()]) if (!live.has(id)) backoffUntil.delete(id);
      for (const id of [...idlePaused.keys()]) if (!live.has(id)) idlePaused.delete(id);

      const decisions = selectBoxesToRenew(entries, windowMs, now);
      for (const d of decisions) {
        const until = backoffUntil.get(d.boxId);
        if (until != null && now < until) continue; // recently failed — wait

        const lookup = await lookupBox(d.boxId);
        if (!lookup) continue;

        // Seed the tracked deadline from the recorded effective create timeout
        // (falls back to a provider default for pre-feature records).
        let current = tracked.get(d.boxId);
        if (current == null) {
          const createMs = lookup.createdAtMs ?? now;
          const createTimeoutMs =
            lookup.createTimeoutMs ?? (await fallbackCreateTimeoutMs(d.backend));
          current = createMs + createTimeoutMs;
          tracked.set(d.boxId, current);
        }
        // Only renew when the target meaningfully exceeds the tracked deadline,
        // so we don't churn the SDK for sub-tick gains or extend a box still
        // riding its create timeout.
        if (d.targetDeadlineEpochMs <= current + intervalMs) continue;

        try {
          const backend = await resolveCached(d.backend);
          if (!backend?.renewTimeout) continue;
          await backend.renewTimeout({ sandboxId: lookup.sandboxId }, d.targetDeadlineEpochMs, current);
          // Only advance the tracked deadline on SUCCESS — a failed extend did
          // not actually move the real deadline, so we must not record it.
          tracked.set(d.boxId, d.targetDeadlineEpochMs);
          backoffUntil.delete(d.boxId);
          log(
            `cloud-keepalive: renewed box ${d.boxId} (${d.backend}) ` +
              `+${String(Math.round((d.targetDeadlineEpochMs - now) / 60_000))}m`,
          );
        } catch (err) {
          // Plan-cap rejection or a transient SDK error. Leave `tracked`
          // unchanged (so we retry once the backoff lapses) and back the box
          // off briefly to avoid hammering the cap / spamming the log.
          backoffUntil.set(d.boxId, now + FAILURE_BACKOFF_MS);
          const msg = err instanceof Error ? err.message : String(err);
          log(`cloud-keepalive: renew box ${d.boxId} (${d.backend}) failed: ${msg}`);
        }
      }

      // Stop the idle boxes an `inactivity`-model backend can't stop by itself,
      // because our own preview polling keeps resetting its clock.
      const byId = new Map(entries.map((e) => [e.boxId, e]));
      for (const boxId of selectBoxesToIdlePause(entries, windowMs, now)) {
        const e = byId.get(boxId);
        if (!e) continue;
        const backend = await resolveCached(e.backend);
        if (backend?.timeoutModel !== 'inactivity') continue; // absolute TTL: it lapses on its own

        // Don't re-pause a box we already paused: it stays `idle` with the same
        // `updatedAt` while paused, so it would otherwise re-qualify every tick.
        // Any fresh agent activity (a resume that does real work) moves
        // `lastActivityMs` and re-arms it.
        if (idlePaused.get(boxId) === e.lastActivityMs) continue;
        const until = backoffUntil.get(boxId);
        if (until != null && now < until) continue;

        const lookup = await lookupBox(boxId);
        if (!lookup) continue;
        try {
          await backend.pause({ sandboxId: lookup.sandboxId });
          idlePaused.set(boxId, e.lastActivityMs);
          backoffUntil.delete(boxId);
          // Best-effort, and deliberately after the pause is already a fact: a
          // failed record write must not look like a failed pause and re-arm.
          await persistPaused(boxId).catch(() => {});
          const mins = e.lastActivityMs != null ? Math.round((now - e.lastActivityMs) / 60_000) : null;
          log(
            `cloud-keepalive: paused idle box ${boxId} (${e.backend})` +
              (mins != null ? ` after ~${String(mins)}m idle` : '') +
              ` — ${e.backend}'s own idle timer never fires while we poll it`,
          );
        } catch (err) {
          // Already stopped, mid-transition, or a transient SDK error. Back off
          // rather than retry every tick; `probeState` stays authoritative.
          backoffUntil.set(boxId, now + FAILURE_BACKOFF_MS);
          const msg = err instanceof Error ? err.message : String(err);
          log(`cloud-keepalive: pause idle box ${boxId} (${e.backend}) failed: ${msg}`);
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

/** Resolve a box's cloud sandboxId + create facts from `~/.agentbox/state.json`. */
async function defaultLookupBox(boxId: string): Promise<CloudBoxLookup | null> {
  const state = await readState();
  const hit = findBox(boxId, state);
  if (hit.kind !== 'ok') return null;
  const sandboxId = hit.box.cloud?.sandboxId;
  if (!sandboxId) return null;
  return {
    sandboxId,
    createdAtMs: toEpoch(hit.box.createdAt),
    createTimeoutMs: hit.box.cloud?.sessionTimeoutMs ?? null,
  };
}

/**
 * Mark an auto-paused box `paused` on its record. `agentbox list` / `top` / the
 * hub read `cloud.lastState` rather than probing the SDK on every render, so
 * without this the box we just paused keeps showing as `running` until someone
 * runs a live probe. Mirrors cloud-provider's `persistLastState` (which covers
 * the CLI-driven `pause`/`stop`); best-effort, since the pause itself already
 * happened and a state-write failure must not turn into a retry loop.
 */
async function defaultPersistPaused(boxId: string): Promise<void> {
  const state = await readState();
  const hit = findBox(boxId, state);
  if (hit.kind !== 'ok' || !hit.box.cloud) return;
  await recordBox({ ...hit.box, cloud: { ...hit.box.cloud, lastState: 'paused' } });
}

/**
 * Fallback create timeout for a box record that predates `sessionTimeoutMs`.
 * Vercel reads the global `box.vercelTimeoutMs`; other backends use the shared
 * 45-min default (matches the backends' `DEFAULT_TIMEOUT_MS`). A close estimate
 * is enough — the renew gate tolerates seed drift and self-corrects.
 */
async function defaultFallbackCreateTimeoutMs(backend: string): Promise<number> {
  const generic = 45 * 60_000;
  if (backend !== 'vercel') return generic;
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
