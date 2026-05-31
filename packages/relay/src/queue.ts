import { spawn } from 'node:child_process';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BUILT_IN_DEFAULTS,
  GLOBAL_CONFIG_FILE,
  parseUserConfig,
  type UserConfig,
} from '@agentbox/config';
import { readState, STATE_DIR, STATE_FILE } from '@agentbox/sandbox-core';
import type { BoxRecord } from '@agentbox/core';
import type { BoxRegistry } from './registry.js';
import type { BoxStatusStore } from './status-store.js';

export const QUEUE_DIR = join(STATE_DIR, 'queue');

export type QueueJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type QueueAgentKind = 'claude-code' | 'codex' | 'opencode';

/** On-disk job manifest. Read/written under `~/.agentbox/queue/<id>.json`. */
export interface QueueJob {
  id: string;
  agent: QueueAgentKind;
  status: QueueJobStatus;
  /** Friendly box name the worker should create the box under. */
  boxName: string;
  providerName: string;
  /** Original initial-prompt text the user passed via `-i`. */
  prompt: string;
  /** Extra argv tokens passed after `--`. */
  agentArgs: string[];
  /** Workspace + create-time options the worker reconstructs from. */
  createOpts: QueueJobCreateOpts;
  /** Per-job concurrency ceiling (--max-running override, else the global). */
  maxConcurrent: number;
  /**
   * Per-job working-agent ceiling (--max-working override, else the global
   * `queue.maxWorking`). Only consulted when the working-agent gate is active
   * (`queue.maxWorking > 0`). Absent → use the global.
   */
  maxWorking?: number;
  /**
   * Box id the worker created for this job, written back to the manifest as
   * soon as `createBox` returns (before the agent session starts). Lets the
   * working-agent counter join a `running` manifest to its live box status and
   * avoid double-counting the in-flight startup slot once the box registers.
   */
  boxId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Per-job log file path the worker writes to. */
  logPath: string;
  /** PID of the running worker. */
  pid?: number;
  /** Free-form context attached on terminal status flips. */
  reason?: string;
  /** Exit code of the worker process (only set on done/failed). */
  exitCode?: number;
}

/**
 * Minimal subset of CLI create flags the queued worker needs to reconstruct
 * the box. Kept narrow on purpose: anything that only changes interactive
 * attach behavior is irrelevant for the background path.
 */
export interface QueueJobCreateOpts {
  workspace: string;
  name?: string;
  hostSnapshot?: boolean;
  snapshot?: string;
  image?: string;
  withPlaywright?: boolean;
  withEnv?: boolean;
  vnc?: boolean;
  sharedDockerCache?: boolean;
  portless?: boolean;
  sessionName?: string;
  /** Per-box override of `<agent>.dangerouslySkipPermissions` (`--no-...`). */
  dangerouslySkipPermissions?: boolean;
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
}

export interface QueueConfig {
  enabled: boolean;
  maxConcurrent: number;
  /** Max concurrently-working agents before `-i` jobs queue. 0 = disabled (use the running-box gate). */
  maxWorking: number;
  /** Debounce: ms an agent must stay non-working before it frees its working slot. */
  idleGraceMs: number;
}

/**
 * Global+built-in queue config (mirrors `loadAutopauseConfig`): re-read every
 * tick so `agentbox config set --global queue.*` takes effect without a relay
 * restart. Project/workspace layers are intentionally ignored — the relay is
 * host-wide.
 */
export async function loadQueueConfig(): Promise<QueueConfig> {
  const d = BUILT_IN_DEFAULTS.queue;
  let global: Partial<UserConfig> = {};
  try {
    global = parseUserConfig(await readFile(GLOBAL_CONFIG_FILE, 'utf8'), GLOBAL_CONFIG_FILE);
  } catch {
    // ENOENT / parse error → built-in defaults.
  }
  const q = global.queue ?? {};
  return {
    enabled: q.enabled ?? d.enabled,
    maxConcurrent: q.maxConcurrent ?? d.maxConcurrent,
    maxWorking: q.maxWorking ?? d.maxWorking,
    idleGraceMs: (q.idleGraceSeconds ?? d.idleGraceSeconds) * 1_000,
  };
}

/**
 * Atomically write a job manifest. Writes to a sibling `.tmp` file then renames
 * — readers never see a half-written JSON file. Idempotent: missing queue dir
 * is created as needed.
 */
export async function writeJob(job: QueueJob): Promise<void> {
  await mkdir(QUEUE_DIR, { recursive: true });
  const final = join(QUEUE_DIR, `${job.id}.json`);
  const tmp = `${final}.tmp.${String(process.pid)}.${String(Date.now())}`;
  await writeFile(tmp, JSON.stringify(job, null, 2) + '\n', 'utf8');
  await rename(tmp, final);
}

/** Read a single job manifest by id. Returns null when missing. */
export async function readJob(id: string): Promise<QueueJob | null> {
  try {
    const raw = await readFile(join(QUEUE_DIR, `${id}.json`), 'utf8');
    return JSON.parse(raw) as QueueJob;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Best-effort delete of a job manifest. ENOENT is not an error. */
export async function deleteJob(id: string): Promise<void> {
  try {
    await unlink(join(QUEUE_DIR, `${id}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Read every job manifest in the queue dir. Skips temp files (atomic-rename
 * leftovers) and entries that fail to parse — the loop must never crash on a
 * malformed file. Sorted by `createdAt` ascending for FIFO selection.
 */
export async function loadQueue(): Promise<QueueJob[]> {
  let entries: string[];
  try {
    entries = await readdir(QUEUE_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: QueueJob[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(QUEUE_DIR, name), 'utf8');
      out.push(JSON.parse(raw) as QueueJob);
    } catch {
      // skip malformed — surfaced via tick log if it stays put
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return out;
}

/**
 * Pure selector: pick the oldest queued job that can start given the current
 * cross-provider running count. Per-job `maxConcurrent` ceiling wins (a job
 * with `--max-running 3` starts even when the global cap is 1). Returns null
 * when nothing can start right now.
 */
export function selectNextRunnable(jobs: QueueJob[], runningCount: number): QueueJob | null {
  // jobs is FIFO by createdAt already (loadQueue sorts).
  for (const j of jobs) {
    if (j.status !== 'queued') continue;
    if (runningCount < j.maxConcurrent) return j;
  }
  return null;
}

// ---- working-agent gate ---------------------------------------------------
//
// When `queue.maxWorking > 0` the scheduler caps the number of *working*
// (quota-consuming) agents instead of running boxes. The signal is each box's
// live activity state in the relay's BoxStatusStore (fed for docker and cloud
// alike). A box that has finished thinking and is waiting for the user no
// longer occupies a slot, so the next queued job starts — without pausing the
// finished box.

/** Activity union the working gate reasons about (mirrors @agentbox/ctl's `ClaudeActivityState`). */
export type WorkingAgentState =
  | 'working'
  | 'idle'
  | 'waiting'
  | 'end-plan'
  | 'question'
  | 'compacting'
  | 'error'
  | 'unknown';

const WORKING_AGENT_STATES: readonly WorkingAgentState[] = [
  'working',
  'idle',
  'waiting',
  'end-plan',
  'question',
  'compacting',
  'error',
  'unknown',
];

function isWorkingAgentState(v: unknown): v is WorkingAgentState {
  return typeof v === 'string' && (WORKING_AGENT_STATES as readonly string[]).includes(v);
}

/**
 * Boot window during which a freshly-created box (agent not yet reporting a
 * state) still counts as occupying a slot. Must exceed worst-case box
 * create + session launch before the first `working` hook fires, or a burst
 * of queued jobs would over-start before any reports working. Internal
 * constant, not user-tunable (it's a correctness guard, not a preference).
 */
export const STARTUP_GRACE_MS = 90_000;

/** One box's facts the pure working-slot predicate reasons about. No I/O, no clock. */
export interface WorkingSlotEntry {
  /** boxId (registered box) — for logging/debug only. */
  key: string;
  /** Most-recent active-agent state across claude/codex/opencode, or null when no snapshot. */
  agentState: WorkingAgentState | null;
  /** ms since that agent's `updatedAt` (now - updatedAt), or null. */
  sinceUpdateMs: number | null;
  /** ms since the box was created (now - box.createdAt), or null. */
  sinceCreateMs: number | null;
}

/**
 * Pure predicate: does this box occupy a working slot right now?
 *   - working/compacting           → yes (actively consuming quota)
 *   - unknown/no-snapshot, booting  → yes while within {@link STARTUP_GRACE_MS}
 *   - idle/waiting/end-plan/question→ yes only while within the debounce window
 *     (`now - updatedAt < idleGraceMs`); this absorbs brief idle flaps between
 *     turns so a slot isn't freed-then-reclaimed in a thrash.
 *   - error, or anything past its window → no (slot frees).
 */
export function occupiesWorkingSlot(e: WorkingSlotEntry, idleGraceMs: number): boolean {
  if (e.agentState === 'working' || e.agentState === 'compacting') return true;
  if (
    (e.agentState === null || e.agentState === 'unknown') &&
    e.sinceCreateMs !== null &&
    e.sinceCreateMs < STARTUP_GRACE_MS
  ) {
    return true;
  }
  if (
    (e.agentState === 'idle' ||
      e.agentState === 'waiting' ||
      e.agentState === 'end-plan' ||
      e.agentState === 'question') &&
    e.sinceUpdateMs !== null &&
    e.sinceUpdateMs < idleGraceMs
  ) {
    return true;
  }
  return false;
}

export function countWorkingSlots(entries: WorkingSlotEntry[], idleGraceMs: number): number {
  return entries.reduce((n, e) => (occupiesWorkingSlot(e, idleGraceMs) ? n + 1 : n), 0);
}

/**
 * Pure selector mirroring {@link selectNextRunnable} but for the working-agent
 * gate: pick the oldest queued job whose effective working ceiling (per-job
 * `maxWorking`, else the global) is above the current working count.
 */
export function selectNextRunnableByWorking(
  jobs: QueueJob[],
  workingCount: number,
  globalMaxWorking: number,
): QueueJob | null {
  for (const j of jobs) {
    if (j.status !== 'queued') continue;
    const ceil =
      typeof j.maxWorking === 'number' && j.maxWorking > 0 ? j.maxWorking : globalMaxWorking;
    if (workingCount < ceil) return j;
  }
  return null;
}

/**
 * Pick the active agent's state from a box-status snapshot. `claude` is always
 * present (codex/opencode are additive), so prefer whichever agent reports a
 * quota-consuming state, else the most-recently-updated one. Returns nulls
 * when no snapshot / no recognizable state.
 */
export function readActiveAgent(snap: Record<string, unknown> | undefined): {
  state: WorkingAgentState | null;
  updatedAt: string | null;
} {
  if (!snap || typeof snap !== 'object') return { state: null, updatedAt: null };
  const candidates: Array<{ state: WorkingAgentState; updatedAt: string | null }> = [];
  for (const key of ['claude', 'codex', 'opencode']) {
    const sub = (snap as Record<string, unknown>)[key];
    if (!sub || typeof sub !== 'object') continue;
    const o = sub as Record<string, unknown>;
    if (!isWorkingAgentState(o.state)) continue;
    candidates.push({
      state: o.state,
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
    });
  }
  if (candidates.length === 0) return { state: null, updatedAt: null };
  const active = candidates.find((c) => c.state === 'working' || c.state === 'compacting');
  if (active) return active;
  candidates.sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt));
  return candidates[0]!;
}

function parseTime(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function msSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Date.now() - t;
}

export type RunningCountFn = () => Promise<number>;
export type CountWorkingFn = (idleGraceMs: number) => Promise<number>;

export interface QueueLoopDeps {
  log: (line: string) => void;
  /** Injectable; defaults to global-config loader. */
  loadConfig?: () => Promise<QueueConfig>;
  /** Injectable; defaults to docker inspect + cloud-as-running (see {@link defaultCountRunningBoxes}). */
  countRunning?: RunningCountFn;
  /**
   * Injectable working-agent counter (used when `queue.maxWorking > 0`).
   * Defaults to {@link defaultCountWorkingBoxes} over `registry` + `statusStore`.
   */
  countWorking?: CountWorkingFn;
  /** The relay's box registry; required (with `statusStore`) for the working gate. */
  registry?: Pick<BoxRegistry, 'list'>;
  /** The relay's box-status store; required (with `registry`) for the working gate. */
  statusStore?: Pick<BoxStatusStore, 'get'>;
  /** Injectable; defaults to `spawn detached node <cliEntry> _run-queued-job <id>`. */
  spawnWorker?: (job: QueueJob) => Promise<number | null>;
  /** Hook invoked when a manifest's status flips. Tests inject to assert. */
  onStatusChange?: (job: QueueJob) => void;
  intervalMs?: number;
}

export interface QueueLoopHandle {
  stop: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 2_000;

/**
 * Periodic queue scheduler. Runs alongside the autopause loop in the host
 * relay: every tick, count running boxes, pick the oldest startable queued
 * job, atomically flip it to `running`, then spawn the worker. Worker
 * crash/reboot recovery: on relay start, any `running` manifest whose PID
 * is no longer alive gets flipped to `failed` (the slot is recouped
 * automatically because we count live provider state, not manifests).
 */
export function startQueueLoop(deps: QueueLoopDeps): QueueLoopHandle {
  const loadConfig = deps.loadConfig ?? loadQueueConfig;
  const countRunning = deps.countRunning ?? defaultCountRunningBoxes;
  const spawnWorker = deps.spawnWorker ?? defaultSpawnWorker;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const { log, onStatusChange } = deps;

  const countWorking: CountWorkingFn | null =
    deps.countWorking ??
    (deps.registry && deps.statusStore
      ? (idleGraceMs) => defaultCountWorkingBoxes(deps.registry!, deps.statusStore!, idleGraceMs)
      : null);

  let ticking = false;
  let stopped = false;
  let warnedNoWorkingDeps = false;
  let inFlight: Promise<void> = recoverOrphanedWorkers(log, onStatusChange).catch((err) => {
    log(`queue: orphan recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled) return;

      const jobs = await loadQueue();
      const hasQueued = jobs.some((j) => j.status === 'queued');
      if (!hasQueued) return;

      // Working-agent gate when `queue.maxWorking > 0` and the relay wired in
      // its registry + status store; otherwise the legacy running-box gate.
      let gateByWorking = cfg.maxWorking > 0;
      if (gateByWorking && !countWorking) {
        gateByWorking = false;
        if (!warnedNoWorkingDeps) {
          warnedNoWorkingDeps = true;
          log('queue: maxWorking set but registry/statusStore not wired; using running-box gate');
        }
      }

      // Start as many slots as we can in one tick — picking one per tick would
      // mean a 2s lag per job after a slot frees, which adds up when a burst
      // of jobs queues against a freshly-cleared pool.
      while (!stopped) {
        let occupancy: number;
        let next: QueueJob | null;
        if (gateByWorking && countWorking) {
          occupancy = await countWorking(cfg.idleGraceMs);
          const fresh = await loadQueue();
          next = selectNextRunnableByWorking(fresh, occupancy, cfg.maxWorking);
        } else {
          occupancy = await countRunning();
          const fresh = await loadQueue();
          next = selectNextRunnable(fresh, occupancy);
        }
        if (!next) return;
        // Atomic claim: re-read to make sure no other process already started
        // it (the relay is the only writer of status: running, but a
        // future-second-relay scenario would clobber here without this read).
        const current = await readJob(next.id);
        if (!current || current.status !== 'queued') continue;
        const updated: QueueJob = {
          ...current,
          status: 'running',
          startedAt: new Date().toISOString(),
        };
        await writeJob(updated);
        onStatusChange?.(updated);

        try {
          const pid = await spawnWorker(updated);
          if (typeof pid === 'number') {
            const withPid: QueueJob = { ...updated, pid };
            await writeJob(withPid);
            onStatusChange?.(withPid);
            const ceil = gateByWorking
              ? typeof updated.maxWorking === 'number' && updated.maxWorking > 0
                ? updated.maxWorking
                : cfg.maxWorking
              : updated.maxConcurrent;
            log(
              `queue: started job ${updated.id} (${updated.agent}) as pid ${String(pid)}; ${gateByWorking ? 'working' : 'running'} ${String(occupancy + 1)}/${String(ceil)}`,
            );
          } else {
            log(`queue: started job ${updated.id} (${updated.agent}); pid unknown`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const failed: QueueJob = {
            ...updated,
            status: 'failed',
            finishedAt: new Date().toISOString(),
            reason: `worker-spawn-failed: ${msg}`,
          };
          await writeJob(failed);
          onStatusChange?.(failed);
          log(`queue: spawn for job ${updated.id} failed: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`queue: tick error: ${msg}`);
    } finally {
      ticking = false;
    }
  }

  /** Inject manual ticks (after enqueue HTTP). Caller is fire-and-forget. */
  function poke(): void {
    if (stopped) return;
    inFlight = tick();
  }

  // Expose poke on the handle in addition to stop, so the HTTP enqueue route
  // can trigger an immediate scheduling pass without waiting for the timer.
  const handle: QueueLoopHandle & { poke: () => void } = {
    poke,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight.catch(() => {});
    },
  };

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = tick();
  }, intervalMs);
  timer.unref();

  return handle;
}

/**
 * Scrub `running` manifests whose PID is no longer alive — usually after a
 * host reboot or a relay crash mid-flight. The slot is recouped automatically
 * because `countRunning` reads live provider state, but the manifest must be
 * advanced or `agentbox queue list` keeps lying about what's in progress.
 */
async function recoverOrphanedWorkers(
  log: (line: string) => void,
  onChange?: (job: QueueJob) => void,
): Promise<void> {
  const jobs = await loadQueue();
  for (const j of jobs) {
    if (j.status !== 'running') continue;
    if (typeof j.pid === 'number' && processAlive(j.pid)) continue;
    const failed: QueueJob = {
      ...j,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      reason: 'worker-died',
    };
    await writeJob(failed);
    onChange?.(failed);
    log(`queue: recovered orphan job ${j.id} (pid ${String(j.pid ?? '?')} not alive) -> failed`);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Count concurrently *working* agents for the working-agent gate. Computed
 * fresh each call from in-memory relay state (no docker shell-out, no cache):
 *   - one {@link WorkingSlotEntry} per registered box, from its live status
 *     snapshot (`statusStore`) and creation time (`registry`), scored by
 *     {@link occupiesWorkingSlot};
 *   - plus each `running` queue job whose box hasn't registered yet (in-flight
 *     create), so a burst can't over-start before the first box reports. A job
 *     whose `boxId` is already in the registry is counted via its box entry
 *     (no double count); a job whose worker PID is dead is skipped (the box,
 *     if it exists, is counted via the registry).
 */
export async function defaultCountWorkingBoxes(
  registry: Pick<BoxRegistry, 'list'>,
  statusStore: Pick<BoxStatusStore, 'get'>,
  idleGraceMs: number,
): Promise<number> {
  const boxes = registry.list();
  const registeredIds = new Set(boxes.map((b) => b.boxId));
  const entries: WorkingSlotEntry[] = boxes.map((b) => {
    const active = readActiveAgent(statusStore.get(b.boxId));
    return {
      key: b.boxId,
      agentState: active.state,
      sinceUpdateMs: msSince(active.updatedAt),
      sinceCreateMs: msSince(b.createdAt),
    };
  });
  const count = countWorkingSlots(entries, idleGraceMs);

  let jobs: QueueJob[];
  try {
    jobs = await loadQueue();
  } catch {
    return count;
  }
  return count + countInFlightCreateJobs(jobs, registeredIds);
}

/**
 * Count `running` queue jobs whose box isn't yet accounted for elsewhere — an
 * in-flight create that occupies a concurrency slot before its box exists.
 * Shared by both gates: the caller passes the set of box ids it already counted
 * (relay registry ids for the working gate, state.json ids for the running
 * gate), so a job is added only while its box is invisible to that source. A
 * job whose worker pid is dead is skipped (its box, if any, is counted directly;
 * the orphan-recovery sweep flips the stale manifest to `failed`).
 */
export function countInFlightCreateJobs(jobs: QueueJob[], accountedBoxIds: Set<string>): number {
  let n = 0;
  for (const j of jobs) {
    if (j.status !== 'running') continue;
    if (j.boxId && accountedBoxIds.has(j.boxId)) continue; // counted via its box
    if (typeof j.pid === 'number' && !processAlive(j.pid)) continue; // dead worker
    n += 1;
  }
  return n;
}

const RUNNING_COUNT_CACHE_MS = 3_000;
let boxStateCache: { boxCount: number; stateIds: Set<string>; expiresAt: number } | null = null;

/**
 * Cross-provider count of boxes whose runtime state is `running`, plus the
 * in-flight queue jobs whose box isn't in `state.json` yet.
 *
 * The box-state portion reads `~/.agentbox/state.json`, then per-provider:
 *   - docker: `docker inspect --format {{.State.Status}}` shell-out (cheap).
 *   - non-docker (daytona/hetzner/…): counted as running. Cloud providers
 *     don't expose a cheap synchronous probe; the autopause/queue loops would
 *     pay an SDK round-trip per box per tick otherwise. Tracked as a v1
 *     limitation: a paused cloud box still counts against the slot cap until
 *     it's destroyed. Acceptable because cloud pause is rare today.
 * That portion is cached for 3s so multiple slot decisions in one tick share it.
 *
 * The in-flight term is recomputed every call (a cheap `loadQueue` fs read), NOT
 * cached: a job the scheduler just flipped to `running` hasn't created its box
 * yet (~25s on cloud, image pull on docker), so it's absent from `state.json`.
 * Without counting it, the per-tick "start as many as fit" loop would re-select
 * the same free slot for the next job and over-start past `--max-running`.
 */
export async function defaultCountRunningBoxes(): Promise<number> {
  const { boxCount, stateIds } = await cachedBoxState();
  let jobs: QueueJob[];
  try {
    jobs = await loadQueue();
  } catch {
    return boxCount;
  }
  return boxCount + countInFlightCreateJobs(jobs, stateIds);
}

async function cachedBoxState(): Promise<{ boxCount: number; stateIds: Set<string> }> {
  const now = Date.now();
  if (boxStateCache && boxStateCache.expiresAt > now) {
    return { boxCount: boxStateCache.boxCount, stateIds: boxStateCache.stateIds };
  }
  const fresh = await uncachedBoxStateCount();
  boxStateCache = { ...fresh, expiresAt: now + RUNNING_COUNT_CACHE_MS };
  return fresh;
}

/** Running-box count from `state.json` plus the set of those boxes' ids (for
 *  in-flight-job dedup). Read errors / no boxes → zero and an empty set. */
async function uncachedBoxStateCount(): Promise<{ boxCount: number; stateIds: Set<string> }> {
  let boxes: BoxRecord[];
  try {
    boxes = (await readState(STATE_FILE)).boxes;
  } catch {
    return { boxCount: 0, stateIds: new Set() };
  }
  const stateIds = new Set(boxes.map((b) => b.id));
  if (boxes.length === 0) return { boxCount: 0, stateIds };

  let boxCount = 0;
  const dockerBoxes: BoxRecord[] = [];
  for (const b of boxes) {
    const provider = b.provider ?? 'docker';
    if (provider === 'docker') {
      dockerBoxes.push(b);
    } else {
      // Optimistic: count cloud boxes as running. See note on
      // {@link defaultCountRunningBoxes} for why.
      boxCount += 1;
    }
  }
  if (dockerBoxes.length > 0) {
    const states = await Promise.all(dockerBoxes.map((b) => inspectDockerState(b.container)));
    for (const s of states) {
      if (s === 'running') boxCount += 1;
    }
  }
  return { boxCount, stateIds };
}

function inspectDockerState(containerName: string): Promise<'running' | 'other'> {
  return new Promise<'running' | 'other'>((resolveP) => {
    const child = spawn('docker', ['inspect', '--format', '{{.State.Status}}', containerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const finish = (state: 'running' | 'other'): void => {
      if (settled) return;
      settled = true;
      resolveP(state);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish('other');
    }, 10_000);
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish('other');
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish(out.trim() === 'running' ? 'running' : 'other');
    });
  });
}

/**
 * Default worker spawner: detached `node <cliEntry> _run-queued-job <id>`,
 * with stdout/stderr appended to the job's `logPath`. The CLI entry is set by
 * `ensureRelay` via `AGENTBOX_CLI_ENTRY` (the same hook checkpoint/cp/download
 * RPCs already use). Returns the worker PID, or null when the spawn produced
 * no PID (treated as a soft failure — the loop's catch turns it into a
 * `failed` manifest).
 */
async function defaultSpawnWorker(job: QueueJob): Promise<number | null> {
  const entry = process.env.AGENTBOX_CLI_ENTRY;
  if (!entry || !existsSync(entry)) {
    throw new Error(
      `AGENTBOX_CLI_ENTRY not set or missing (${String(entry)}); cannot spawn queue worker`,
    );
  }
  await mkdir(join(STATE_DIR, 'logs'), { recursive: true });
  const fd = openSync(job.logPath, 'a');
  const child = spawn(process.execPath, [entry, '_run-queued-job', job.id], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref();
  // The fd stays open in the child; close our own copy.
  try {
    closeSync(fd);
  } catch {
    /* the child still holds its own fd */
  }
  return typeof child.pid === 'number' ? child.pid : null;
}

/** Re-export the path for callers (CLI submit helper, tests). */
export const QUEUE_LOGS_DIR = join(STATE_DIR, 'logs');

/** Build the per-job log path. Kept here so submit + worker agree on layout. */
export function queueLogPath(id: string): string {
  return join(QUEUE_LOGS_DIR, `queue-${id}.log`);
}

/** Wait briefly for a file to appear (queue manifest after enqueue HTTP). */
export async function waitForFile(path: string, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await delay(25);
  }
  return existsSync(path);
}
