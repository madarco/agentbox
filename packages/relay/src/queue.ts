import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
import type { BoxRecord, ResolvedCarryEntry } from '@agentbox/core';
import type { BoxRegistry } from './registry.js';
import type { BoxStatusStore } from './status-store.js';

export const QUEUE_DIR = join(STATE_DIR, 'queue');

/**
 * Concurrency ceiling for `kind: 'prepare'` (image-bake) jobs — a separate lane
 * from box creation. Serialized to 1: bakes are resource-heavy (a docker build,
 * a booted VPS) and each pins project config on success, so running one at a
 * time avoids contention and write races. A second bake queues behind the first.
 */
export const PREPARE_MAX_CONCURRENT = 1;

export type QueueJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type QueueAgentKind = 'claude-code' | 'codex' | 'opencode';

/**
 * Host-terminal targeting captured on the submitting host when `queue.openIn`
 * is not `none`, carried on the job so the worker can open a fresh terminal
 * onto the box the moment it is ready. The relay treats this as opaque
 * pass-through; the CLI worker (`_run-queued-job`) is what reads and acts on it.
 *
 * The targeting is captured at submit time because the relay daemon is
 * long-lived and idempotent — its own env reflects whatever terminal first
 * started it, not this submit's terminal.
 */
export interface QueueJobOpenTerminal {
  host: 'tmux' | 'cmux' | 'herdr' | 'iterm2';
  mode: 'split' | 'window' | 'tab';
  /** Submitting shell's cwd, so the new pane resolves project-scoped refs. */
  cwd: string;
  /** tmux server socket (`$TMUX`) + the pane to split (`$TMUX_PANE`). */
  tmuxSocket?: string;
  tmuxPane?: string;
  /** cmux control socket (`$CMUX_SOCKET_PATH`) + bundled CLI path. */
  cmuxSocket?: string;
  cmuxBundledCli?: string;
  /** Submitting surface + workspace UUIDs (`$CMUX_SURFACE_ID` /
   *  `$CMUX_WORKSPACE_ID`), so the worker can split the original pane (or, failing
   *  that, the parent workspace) instead of opening a new top-level workspace. */
  cmuxSurfaceId?: string;
  cmuxWorkspaceId?: string;
  /** Herdr session socket (`$HERDR_SOCKET_PATH`) + submitting pane/workspace ids
   *  (`$HERDR_PANE_ID` / `$HERDR_WORKSPACE_ID`), so the worker can split the
   *  original pane / add a tab in the parent workspace. */
  herdrSocket?: string;
  herdrPaneId?: string;
  herdrWorkspaceId?: string;
}

/** On-disk job manifest. Read/written under `~/.agentbox/queue/<id>.json`. */
export interface QueueJob {
  id: string;
  /**
   * What the worker does with this job. `create` (default when absent) builds a
   * box. `prepare` bakes a provider's base image — it produces an artifact, not
   * a box, so it is excluded from the box/working concurrency gates and never
   * surfaces as a box in the dashboard. Prepare jobs carry `prepare` (not the
   * agent/create fields, which hold inert placeholders).
   */
  kind?: 'create' | 'prepare';
  agent: QueueAgentKind;
  status: QueueJobStatus;
  /** Friendly box name the worker should create the box under. */
  boxName: string;
  providerName: string;
  /** Original initial-prompt text the user passed via `-i`. */
  prompt: string;
  /** Extra argv tokens passed after `--`. */
  agentArgs: string[];
  /**
   * "Just create the box, don't start an agent" (like `agentbox create`). When
   * true the worker builds the box and stops — no agent session, no prompt.
   * `agent` still holds a value (required by the type) but is ignored.
   */
  noAgent?: boolean;
  /**
   * Seed the agent's first turn with the setup-wizard prompt (generate
   * `agentbox.yaml`) — set by the hub when the project has no `agentbox.yaml`
   * and no default snapshot. Inert when `noAgent` (no agent to run it).
   */
  setupWizard?: boolean;
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
  /**
   * Host-terminal targeting for `queue.openIn`. Set at submit time when the
   * submitting shell ran inside a supported terminal; absent → open nothing.
   */
  openTerminal?: QueueJobOpenTerminal;
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
  /**
   * Interactive Claude re-login sub-state. Set by the worker when it detects an
   * expired/dead Claude login during create and drives a browser re-login in a
   * throwaway docker container (job stays `running` meanwhile). The hub API/UI
   * read `phase`/`url`/`error` to surface the flow; the code endpoint writes
   * `code` back, which the worker consumes and clears. Absent for the normal
   * (creds-OK) path.
   */
  login?: QueueJobLogin;
  /** Bake options for a `kind: 'prepare'` job (see {@link QueueJobPrepare}). */
  prepare?: QueueJobPrepare;
}

/**
 * Claude re-login sub-state carried on a create job. Written **only by the create
 * worker** (worker → UI): `phase`/`url`/`error`/`lastError`. The reverse channel
 * (the pasted OAuth code, UI → worker) rides a separate file — see
 * {@link queueLoginCodePath} — so the two sides never read-modify-write the same
 * object and can't lose each other's updates.
 */
export interface QueueJobLogin {
  required: boolean;
  phase: 'starting' | 'awaiting-code' | 'exchanging' | 'done' | 'error';
  /** OAuth approval URL the user must open; present from `awaiting-code` onward. */
  url?: string;
  /** Terminal failure reason (with `phase: 'error'`). */
  error?: string;
  /** A recoverable note (e.g. a rejected code) — the flow stays usable. */
  lastError?: string;
}

/**
 * Options for a `kind: 'prepare'` job: bake a provider's base image. The worker
 * (`_run-queued-prepare`) calls `provider.prepare({ force, claudeInstall, onLog })`
 * directly and streams progress to the job log.
 */
export interface QueueJobPrepare {
  /** Rebuild even if the base image/snapshot already exists. */
  force?: boolean;
  /** Bake-time Claude install method (falls back to the effective config). */
  claudeInstall?: 'native' | 'npm';
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
  /** Base ref the box's per-box `agentbox/<name>` branch forks from (branch / tag
   *  / SHA). Absent → the host's HEAD. Mirrors the CLI's `--from-branch`. */
  fromBranch?: string;
  image?: string;
  withPlaywright?: boolean;
  withEnv?: boolean;
  vnc?: boolean;
  /** `--no-resync` → false; resync the box with the host on (checkpoint) create. */
  resync?: boolean;
  sharedDockerCache?: boolean;
  portless?: boolean;
  sessionName?: string;
  /** Per-box override of `<agent>.dangerouslySkipPermissions` (`--no-...`). */
  dangerouslySkipPermissions?: boolean;
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
  /**
   * carry: entries the submitter resolved + approved on the host (the same gate
   * the foreground create runs). Plain host-path metadata — serialized into the
   * job and applied by the worker, which reads the host files at create time.
   */
  carry?: ResolvedCarryEntry[];
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

export interface EnqueueQueueJobInput {
  agent: QueueAgentKind;
  boxName: string;
  providerName: string;
  prompt: string;
  agentArgs: string[];
  createOpts: QueueJobCreateOpts;
  /**
   * "Just create the box, don't start an agent" (like `agentbox create`). The
   * worker runs createBox() then stops — no agent session. `agent` is still
   * required by the type but is ignored by the worker when this is set.
   */
  noAgent?: boolean;
  /** Seed the setup-wizard prompt as the agent's first turn (hub create path). */
  setupWizard?: boolean;
  /** Per-invocation override of queue.maxConcurrent. */
  maxRunningOverride?: number;
  /** Per-invocation override of queue.maxWorking. */
  maxWorkingOverride?: number;
  /** Host-terminal targeting captured at submit time (CLI `queue.openIn`). */
  openTerminal?: QueueJobOpenTerminal;
}

export interface EnqueueQueueJobResult {
  job: QueueJob;
  /** Cross-provider running count at the time of enqueue (informational). */
  runningCount: number;
  /** Effective ceiling used for the job (override or global). */
  maxConcurrent: number;
}

/**
 * Build a queued-job manifest and write it to `~/.agentbox/queue/<id>.json`.
 * Pure + transport-free: it does NOT ensure a relay is running and does NOT
 * poke the scheduler — callers do that (the CLI via `POST /admin/queue/enqueue`
 * after `ensureRelay`; the embedded hub via its in-process queue poke). Kept in
 * `@agentbox/relay` so both the CLI `submitQueueJob` wrapper and the hub backend
 * share one manifest-builder without the hub importing `apps/cli`. The scheduler
 * (`startQueueLoop`) picks the manifest up on its next tick regardless.
 */
export async function enqueueQueueJob(
  input: EnqueueQueueJobInput,
): Promise<EnqueueQueueJobResult> {
  const cfg = await loadQueueConfig();
  const ceiling =
    typeof input.maxRunningOverride === 'number' && input.maxRunningOverride > 0
      ? input.maxRunningOverride
      : cfg.maxConcurrent;
  const maxWorking =
    typeof input.maxWorkingOverride === 'number' && input.maxWorkingOverride > 0
      ? input.maxWorkingOverride
      : undefined;

  const id = randomBytes(9).toString('hex');
  const job: QueueJob = {
    id,
    agent: input.agent,
    status: 'queued',
    boxName: input.boxName,
    providerName: input.providerName,
    prompt: input.prompt,
    agentArgs: input.agentArgs,
    ...(input.noAgent ? { noAgent: true } : {}),
    ...(input.setupWizard ? { setupWizard: true } : {}),
    createOpts: input.createOpts,
    maxConcurrent: ceiling,
    ...(maxWorking !== undefined ? { maxWorking } : {}),
    ...(input.openTerminal !== undefined ? { openTerminal: input.openTerminal } : {}),
    createdAt: new Date().toISOString(),
    logPath: queueLogPath(id),
  };
  await writeJob(job);

  let runningCount = 0;
  try {
    runningCount = await defaultCountRunningBoxes();
  } catch {
    runningCount = 0;
  }

  return { job, runningCount, maxConcurrent: ceiling };
}

export interface EnqueuePrepareJobInput {
  /** Provider to bake (docker | daytona | hetzner | vercel | e2b | plugin). */
  providerName: string;
  /** Rebuild even if the base already exists. */
  force?: boolean;
  /** Bake-time Claude install method (else the effective config decides). */
  claudeInstall?: 'native' | 'npm';
  /** Host dir used for config resolution; the worker defaults it if absent. */
  workspace?: string;
}

/**
 * Build a `kind: 'prepare'` manifest and write it to the queue. Like
 * {@link enqueueQueueJob} this is transport-free — the caller pokes the
 * scheduler. The agent/create fields carry inert placeholders (the prepare
 * worker only reads `providerName` + `prepare`); the job is scheduled in its own
 * lane (see {@link PREPARE_MAX_CONCURRENT}) and never surfaces as a box.
 */
export async function enqueuePrepareJob(
  input: EnqueuePrepareJobInput,
): Promise<{ job: QueueJob }> {
  const id = randomBytes(9).toString('hex');
  const prepare: QueueJobPrepare = {
    ...(input.force ? { force: true } : {}),
    ...(input.claudeInstall ? { claudeInstall: input.claudeInstall } : {}),
  };
  const job: QueueJob = {
    id,
    kind: 'prepare',
    agent: 'claude-code', // placeholder — ignored for prepare
    status: 'queued',
    boxName: '',
    providerName: input.providerName,
    prompt: '',
    agentArgs: [],
    createOpts: { workspace: input.workspace ?? process.cwd() },
    prepare,
    maxConcurrent: PREPARE_MAX_CONCURRENT,
    createdAt: new Date().toISOString(),
    logPath: queueLogPath(id),
  };
  await writeJob(job);
  return { job };
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
    if (j.kind === 'prepare') continue; // prepare has its own lane
    if (runningCount < j.maxConcurrent) return j;
  }
  return null;
}

/** Count running prepare jobs (its own concurrency lane). Dead workers skipped. */
export function countRunningPrepareJobs(jobs: QueueJob[]): number {
  let n = 0;
  for (const j of jobs) {
    if (j.kind !== 'prepare') continue;
    if (j.status !== 'running') continue;
    if (typeof j.pid === 'number' && !processAlive(j.pid)) continue;
    n += 1;
  }
  return n;
}

/**
 * Pure selector for the prepare (image-bake) lane: the oldest queued prepare job
 * while under {@link PREPARE_MAX_CONCURRENT}. Independent of the box gates.
 */
export function selectNextRunnablePrepare(
  jobs: QueueJob[],
  runningPrepare: number,
): QueueJob | null {
  if (runningPrepare >= PREPARE_MAX_CONCURRENT) return null;
  for (const j of jobs) {
    if (j.kind !== 'prepare') continue;
    if (j.status !== 'queued') continue;
    return j;
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
    if (j.kind === 'prepare') continue; // prepare has its own lane
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
  let lastSweepAt = 0;
  let inFlight: Promise<void> = recoverOrphanedWorkers(log, onStatusChange).catch((err) => {
    log(`queue: orphan recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled) return;

      // Throttled hygiene sweep of stale terminal manifests (runs regardless of
      // whether anything is queued, so a finished burst gets cleaned up).
      const now = Date.now();
      if (now - lastSweepAt >= SWEEP_INTERVAL_MS) {
        lastSweepAt = now;
        await sweepTerminalJobs(log, now).catch((err) => {
          log(`queue: sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      // Flip jobs whose worker died mid-flight to `failed`. Must run before the
      // no-queued-work early return below, or a dead worker with nothing else
      // queued is never noticed — which is precisely the case that leaves a UI
      // progress card waiting on a job that will never finish.
      await recoverOrphanedWorkers(log, onStatusChange, true).catch((err) => {
        log(`queue: orphan reap failed: ${err instanceof Error ? err.message : String(err)}`);
      });

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
        if (!next) break;
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

      // Prepare (image-bake) lane — independent of the box/working gates. A bake
      // produces an artifact, not a box, so it neither counts against nor is
      // blocked by running boxes. Serialized to PREPARE_MAX_CONCURRENT.
      while (!stopped) {
        const fresh = await loadQueue();
        const runningPrepare = countRunningPrepareJobs(fresh);
        const next = selectNextRunnablePrepare(fresh, runningPrepare);
        if (!next) break;
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
              `queue: started prepare job ${updated.id} (${updated.providerName}) as pid ${String(pid)}; prepare ${String(runningPrepare + 1)}/${String(PREPARE_MAX_CONCURRENT)}`,
            );
          } else {
            log(`queue: started prepare job ${updated.id} (${updated.providerName}); pid unknown`);
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
          log(`queue: spawn for prepare job ${updated.id} failed: ${msg}`);
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
 *
 * `requirePid` distinguishes the two callers:
 * - startup (`false`): a `running` manifest with no PID at all was orphaned by a
 *   relay that died between marking the job running and recording the PID. There
 *   is no worker to wait for, so fail it.
 * - every tick (`true`): only reap a PID we know is dead. A `running` job whose
 *   PID isn't written *yet* is in the spawn window of the current tick — reaping
 *   that would kill jobs as they start.
 *
 * Running this per-tick is what makes a worker that dies mid-flight visible. It
 * used to run only at startup, so a crashed worker left the job `running`
 * forever: no terminal status, no SSE `end`, and a UI progress card that waits
 * on a job that is never coming back.
 */
async function recoverOrphanedWorkers(
  log: (line: string) => void,
  onChange?: (job: QueueJob) => void,
  requirePid = false,
): Promise<void> {
  const jobs = await loadQueue();
  for (const j of jobs) {
    if (j.status !== 'running') continue;
    if (typeof j.pid === 'number' ? processAlive(j.pid) : requirePid) continue;
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

/** Terminal job manifests older than this are swept so `queue list` and the
 *  scheduler don't accumulate unbounded done/failed/cancelled entries (they
 *  never gate concurrency, but they pollute listings and were never cleaned). */
export const TERMINAL_RETENTION_MS = 60 * 60 * 1_000;
const SWEEP_INTERVAL_MS = 60 * 1_000;
const TERMINAL_STATUSES: readonly QueueJobStatus[] = ['done', 'failed', 'cancelled'];

/**
 * Delete terminal (done/failed/cancelled) job manifests whose terminal flip is
 * older than {@link TERMINAL_RETENTION_MS}. Recent terminal jobs are kept so
 * `agentbox queue list` still shows just-finished history. Best-effort: a
 * delete failure is logged-by-omission and retried next sweep.
 */
async function sweepTerminalJobs(log: (line: string) => void, now: number): Promise<void> {
  const jobs = await loadQueue();
  let swept = 0;
  for (const j of jobs) {
    if (!TERMINAL_STATUSES.includes(j.status)) continue;
    const since = Date.parse(j.finishedAt ?? j.createdAt);
    if (Number.isNaN(since) || now - since < TERMINAL_RETENTION_MS) continue;
    await deleteJob(j.id);
    swept += 1;
  }
  if (swept > 0) log(`queue: swept ${String(swept)} stale terminal manifest(s)`);
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
    if (j.kind === 'prepare') continue; // a bake is not a box
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
  // A prepare (image-bake) job runs a different worker; both stream to logPath.
  const command = job.kind === 'prepare' ? '_run-queued-prepare' : '_run-queued-job';
  // Pin an explicit cwd. Without one the worker inherits the daemon's, and this
  // daemon is long-lived while its own directory is not: `npm install -g` (what
  // `self-update` runs) replaces the package tree, so a relay/hub that keeps
  // running across an update sits in a deleted directory. The child then dies on
  // `process.cwd()` at startup — `ENOENT: uv_cwd` — before any of our code runs,
  // which reads as a create that hangs with a Node stack trace for a status line.
  // STATE_DIR is ours and always exists; the worker takes its workspace from the
  // job manifest, never from cwd.
  const child = spawn(process.execPath, [entry, command, job.id], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
    cwd: STATE_DIR,
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

/**
 * The UI → worker channel for a Claude re-login code: a dedicated file next to
 * the manifest. Only the hub writes it ({@link writeQueueLoginCode}); only the
 * worker reads+consumes it ({@link takeQueueLoginCode}). Keeping it out of the
 * job manifest avoids a cross-process read-modify-write race with the worker's
 * `login` (phase/url) writes.
 */
export function queueLoginCodePath(id: string): string {
  return join(QUEUE_DIR, `${id}.login-code`);
}

/** Hub side: deliver the pasted OAuth approval code to a job, written atomically. */
export async function writeQueueLoginCode(id: string, code: string): Promise<void> {
  await mkdir(QUEUE_DIR, { recursive: true });
  const final = queueLoginCodePath(id);
  const tmp = `${final}.tmp.${String(process.pid)}.${String(Date.now())}`;
  await writeFile(tmp, code.trim(), { mode: 0o600 });
  await rename(tmp, final);
}

/** Worker side: read + consume the pending code (deleting it); null when none. */
export async function takeQueueLoginCode(id: string): Promise<string | null> {
  try {
    const code = (await readFile(queueLoginCodePath(id), 'utf8')).trim();
    await unlink(queueLoginCodePath(id)).catch(() => {});
    return code.length > 0 ? code : null;
  } catch {
    return null;
  }
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
