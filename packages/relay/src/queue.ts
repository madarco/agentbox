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
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
}

export interface QueueConfig {
  enabled: boolean;
  maxConcurrent: number;
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

export type RunningCountFn = () => Promise<number>;

export interface QueueLoopDeps {
  log: (line: string) => void;
  /** Injectable; defaults to global-config loader. */
  loadConfig?: () => Promise<QueueConfig>;
  /** Injectable; defaults to docker inspect + cloud-as-running (see {@link defaultCountRunningBoxes}). */
  countRunning?: RunningCountFn;
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

  let ticking = false;
  let stopped = false;
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

      // Start as many slots as we can in one tick — picking one per tick would
      // mean a 2s lag per job after a slot frees, which adds up when a burst
      // of jobs queues against a freshly-cleared pool.
      while (!stopped) {
        const running = await countRunning();
        const fresh = await loadQueue();
        const next = selectNextRunnable(fresh, running);
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
            log(
              `queue: started job ${updated.id} (${updated.agent}) as pid ${String(pid)}; running ${String(running + 1)}/${String(updated.maxConcurrent)}`,
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

const RUNNING_COUNT_CACHE_MS = 3_000;
let runningCountCache: { value: number; expiresAt: number } | null = null;

/**
 * Cross-provider count of boxes whose runtime state is `running`. Reads
 * `~/.agentbox/state.json`, then per-provider:
 *   - docker: `docker inspect --format {{.State.Status}}` shell-out (cheap).
 *   - non-docker (daytona/hetzner/…): counted as running. Cloud providers
 *     don't expose a cheap synchronous probe; the autopause/queue loops would
 *     pay an SDK round-trip per box per tick otherwise. Tracked as a v1
 *     limitation: a paused cloud box still counts against the slot cap until
 *     it's destroyed. Acceptable because cloud pause is rare today.
 * Result cached for 3s — multiple slot decisions in one tick share the count.
 */
export async function defaultCountRunningBoxes(): Promise<number> {
  const now = Date.now();
  if (runningCountCache && runningCountCache.expiresAt > now) {
    return runningCountCache.value;
  }
  const value = await uncachedCountRunningBoxes();
  runningCountCache = { value, expiresAt: now + RUNNING_COUNT_CACHE_MS };
  return value;
}

async function uncachedCountRunningBoxes(): Promise<number> {
  let boxes: BoxRecord[];
  try {
    boxes = (await readState(STATE_FILE)).boxes;
  } catch {
    return 0;
  }
  if (boxes.length === 0) return 0;

  let count = 0;
  const dockerBoxes: BoxRecord[] = [];
  for (const b of boxes) {
    const provider = b.provider ?? 'docker';
    if (provider === 'docker') {
      dockerBoxes.push(b);
    } else {
      // Optimistic: count cloud boxes as running. See note on
      // {@link defaultCountRunningBoxes} for why.
      count += 1;
    }
  }
  if (dockerBoxes.length > 0) {
    const states = await Promise.all(dockerBoxes.map((b) => inspectDockerState(b.container)));
    for (const s of states) {
      if (s === 'running') count += 1;
    }
  }
  return count;
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
