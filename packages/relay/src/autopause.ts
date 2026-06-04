import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  BUILT_IN_DEFAULTS,
  GLOBAL_CONFIG_FILE,
  parseUserConfig,
  type UserConfig,
} from '@agentbox/config';
import { readActiveAgent, type WorkingAgentState } from './queue.js';
import type { BoxRegistry, EventBuffer } from './registry.js';
import type { BoxStatusStore } from './status-store.js';

export interface AutopauseConfig {
  enabled: boolean;
  maxRunningBoxes: number;
  idleMinutes: number;
}

export type ContainerState = 'running' | 'paused' | 'stopped' | 'missing';
export type ClaudeState = 'working' | 'idle' | 'waiting' | 'unknown';

/** One box's runtime facts the pure selector reasons about. No I/O, no clock. */
export interface BoxScanEntry {
  boxId: string;
  containerName: string;
  /** docker inspect status === 'running'. */
  running: boolean;
  /** Latest reported claude activity, or null when no snapshot exists. */
  claudeState: ClaudeState | null;
  /** ms the box has been idle (now - claude.updatedAt) when idle; else null. */
  idleMs: number | null;
  /** Box creation time as epoch ms; 0 when unknown/unparseable. */
  createdAt: number;
}

/**
 * Pure selection: given each running box's idle facts and the config, return
 * the boxIds to pause, in pause order. Pauses only enough to bring the running
 * count back to `maxRunningBoxes`, picking provably-idle boxes longest-idle
 * first (tie-break: oldest box, then boxId for determinism).
 */
export function selectBoxesToPause(entries: BoxScanEntry[], cfg: AutopauseConfig): string[] {
  if (!cfg.enabled) return [];
  const runningCount = entries.reduce((n, e) => (e.running ? n + 1 : n), 0);
  const excess = runningCount - cfg.maxRunningBoxes;
  if (excess <= 0) return [];

  const idleThresholdMs = cfg.idleMinutes * 60_000;
  const candidates = entries.filter(
    (e) => e.running && e.claudeState === 'idle' && e.idleMs != null && e.idleMs >= idleThresholdMs,
  );
  candidates.sort(
    (a, b) =>
      (b.idleMs as number) - (a.idleMs as number) ||
      a.createdAt - b.createdAt ||
      (a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0),
  );
  return candidates.slice(0, excess).map((e) => e.boxId);
}

/**
 * Global+built-in autopause config. The relay is host-wide (not project
 * scoped), so it deliberately ignores the project/workspace layers that
 * `loadEffectiveConfig` would apply. Re-read every tick so
 * `agentbox config set --global autopause.*` takes effect without a relay
 * restart. A missing or malformed global file falls back to built-in defaults.
 */
export async function loadAutopauseConfig(): Promise<AutopauseConfig> {
  const d = BUILT_IN_DEFAULTS.autopause;
  let global: Partial<UserConfig> = {};
  try {
    global = parseUserConfig(await readFile(GLOBAL_CONFIG_FILE, 'utf8'), GLOBAL_CONFIG_FILE);
  } catch {
    // ENOENT (no global config yet) or a parse error -> built-in defaults.
  }
  const a = global.autopause ?? {};
  return {
    enabled: a.enabled ?? d.enabled,
    maxRunningBoxes: a.maxRunningBoxes ?? d.maxRunningBoxes,
    idleMinutes: a.idleMinutes ?? d.idleMinutes,
  };
}

export interface AutopauseLoopDeps {
  registry: BoxRegistry;
  statusStore: BoxStatusStore;
  events: EventBuffer;
  log: (line: string) => void;
  /** Injectable for tests; defaults to the global-config loader. */
  loadConfig?: () => Promise<AutopauseConfig>;
  /** Injectable for tests; defaults to `docker inspect`. */
  inspectStatus?: (containerName: string) => Promise<ContainerState>;
  /** Injectable for tests; defaults to `docker pause`. */
  pause?: (containerName: string) => Promise<void>;
  intervalMs?: number;
}

export interface AutopauseLoopHandle {
  /** Stop scheduling and await any in-flight tick. */
  stop: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 60_000;

export function startAutopauseLoop(deps: AutopauseLoopDeps): AutopauseLoopHandle {
  const loadConfig = deps.loadConfig ?? loadAutopauseConfig;
  const inspectStatus = deps.inspectStatus ?? inspectContainerState;
  const pause = deps.pause ?? pauseContainer;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const { registry, statusStore, events, log } = deps;

  let ticking = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function tick(): Promise<void> {
    // A slow tick (many `docker inspect`s) must not overlap the next interval.
    if (ticking) return;
    ticking = true;
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled) return;

      const entries: BoxScanEntry[] = [];
      for (const reg of registry.list()) {
        if (!reg.containerName) continue; // pre-feature box; can't pause it
        const state = await inspectStatus(reg.containerName);
        const active = readPauseState(statusStore.get(reg.boxId));
        const idleMs =
          active.state === 'idle' && active.updatedAt ? msSince(active.updatedAt) : null;
        entries.push({
          boxId: reg.boxId,
          containerName: reg.containerName,
          running: state === 'running',
          claudeState: active.state,
          idleMs,
          createdAt: reg.createdAt ? toEpoch(reg.createdAt) : 0,
        });
      }

      const toPause = selectBoxesToPause(entries, cfg);
      if (toPause.length === 0) return;

      const byId = new Map(entries.map((e) => [e.boxId, e]));
      const runningBefore = entries.reduce((n, e) => (e.running ? n + 1 : n), 0);
      for (const boxId of toPause) {
        const e = byId.get(boxId);
        if (!e) continue;
        try {
          await pause(e.containerName);
          const mins = e.idleMs != null ? Math.round(e.idleMs / 60_000) : null;
          events.append({
            boxId,
            type: 'autopause',
            payload: {
              containerName: e.containerName,
              action: 'paused',
              idleMs: e.idleMs,
              runningBefore,
              max: cfg.maxRunningBoxes,
            },
          });
          log(
            `autopause: paused box ${boxId} (${e.containerName})` +
              (mins != null ? ` after ~${String(mins)}m idle` : '') +
              `; running ${String(runningBefore)} -> target ${String(cfg.maxRunningBoxes)}`,
          );
        } catch (err) {
          // docker failure is non-fatal: log, record, keep going.
          const msg = err instanceof Error ? err.message : String(err);
          log(`autopause: docker pause ${e.containerName} failed: ${msg}`);
          events.append({
            boxId,
            type: 'autopause',
            payload: { containerName: e.containerName, action: 'pause-failed', error: msg },
          });
        }
      }
    } catch (err) {
      // The loop must never crash the relay or stop scheduling.
      const msg = err instanceof Error ? err.message : String(err);
      log(`autopause: tick error: ${msg}`);
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = tick();
  }, intervalMs);
  // The HTTP server keeps the process alive; the timer shouldn't on its own.
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight.catch(() => {});
    },
  };
}

interface ClaudeSnap {
  state: ClaudeState | null;
  updatedAt: string | null;
}

/**
 * Coarse activity state for the pause decision, across ALL agents
 * (claude/codex/opencode) — not just claude. Reuses the queue loop's
 * multi-agent reader so a box where codex/opencode is working isn't paused
 * because claude happens to be idle or absent. Any active state (working,
 * compacting, waiting, end-plan, question, error) maps to a non-`idle` value,
 * so only a box whose live agent has settled to `idle` becomes a candidate.
 */
function readPauseState(snap: Record<string, unknown> | undefined): ClaudeSnap {
  const active = readActiveAgent(snap);
  return { state: coarsePauseState(active.state), updatedAt: active.updatedAt };
}

function coarsePauseState(s: WorkingAgentState | null): ClaudeState | null {
  switch (s) {
    case 'idle':
      return 'idle';
    case 'waiting':
      return 'waiting';
    case 'working':
    case 'compacting':
      return 'working';
    case null:
      return null;
    // end-plan / question / error / unknown: a live session expecting attention
    // — never auto-pause it (maps to a non-idle, non-candidate state).
    default:
      return 'unknown';
  }
}

function msSince(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Date.now() - t;
}

function toEpoch(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

const INSPECT_TIMEOUT_MS = 15_000;
const PAUSE_TIMEOUT_MS = 30_000;

interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runDocker(args: string[], timeoutMs: number): Promise<DockerResult> {
  return new Promise<DockerResult>((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      stderr += `\nrelay: docker ${args.join(' ')} timed out after ${String(timeoutMs)}ms\n`;
      finish(124);
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      stderr += String(err.message ?? err);
      finish(127);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code ?? -1);
    });
  });
}

/** Mirrors `inspectContainerStatus` in @agentbox/sandbox-docker (no dep on it — cycle). */
async function inspectContainerState(name: string): Promise<ContainerState> {
  const r = await runDocker(['inspect', '--format', '{{.State.Status}}', name], INSPECT_TIMEOUT_MS);
  if (r.exitCode !== 0) return 'missing';
  switch (r.stdout.trim()) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'created':
    case 'exited':
    case 'dead':
    case 'restarting':
    case 'removing':
      return 'stopped';
    default:
      return 'missing';
  }
}

async function pauseContainer(name: string): Promise<void> {
  const r = await runDocker(['pause', name], PAUSE_TIMEOUT_MS);
  if (r.exitCode !== 0) {
    throw new Error(r.stderr.trim() || `docker pause ${name} exited ${String(r.exitCode)}`);
  }
}
