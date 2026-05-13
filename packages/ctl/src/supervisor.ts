import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  describeCommand,
  type CtlConfig,
  type ServiceSpec,
  type TaskSpec,
} from './config.js';
import { startProbe, type ProbeHandle } from './probe.js';
import type {
  LogEvent,
  ServiceState,
  ServiceStatus,
  TaskState,
  TaskStatus,
} from './types.js';

const RING_SIZE = 1000;

class Ring<T> {
  private readonly buf: T[] = [];
  constructor(private readonly size: number) {}
  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.size) this.buf.shift();
  }
  tail(n: number): T[] {
    if (n >= this.buf.length) return this.buf.slice();
    return this.buf.slice(this.buf.length - n);
  }
}

export interface RunnerOptions {
  logDir: string;
  cwd: string;
  spawn?: typeof spawn;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (h: NodeJS.Timeout) => void;
}

interface ServiceRunnerEvents {
  log: [LogEvent];
  state: [ServiceState];
}

interface TaskRunnerEvents {
  log: [LogEvent];
  state: [TaskState];
}

export interface Unit {
  readonly kind: 'task' | 'service';
  readonly name: string;
}

function resolveCwd(unitCwd: string | undefined, baseCwd: string): string {
  if (!unitCwd) return baseCwd;
  return unitCwd.startsWith('/') ? unitCwd : join(baseCwd, unitCwd);
}

function spawnArgs(cmd: string | string[]): { bin: string; args: string[] } {
  if (typeof cmd === 'string') return { bin: 'bash', args: ['-c', cmd] };
  return { bin: cmd[0]!, args: cmd.slice(1) };
}

export class ServiceRunner extends EventEmitter<ServiceRunnerEvents> implements Unit {
  readonly kind = 'service' as const;
  private state: ServiceState = 'pending';
  private child: ChildProcess | null = null;
  private restarts = 0;
  private lastExitCode: number | null = null;
  private startedAt: Date | null = null;
  private nextRetryAt: Date | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private currentDelayMs = 0;
  private logStream: WriteStream | null = null;
  private readonly ring = new Ring<LogEvent>(RING_SIZE);
  private wantRunning = false;
  private currentProbe: ProbeHandle | null = null;
  private readonly spawnFn: typeof spawn;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (h: NodeJS.Timeout) => void;

  constructor(
    public readonly spec: ServiceSpec,
    private readonly opts: RunnerOptions,
  ) {
    super();
    this.spawnFn = opts.spawn ?? spawn;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      opts.clearTimer ??
      ((h) => {
        clearTimeout(h);
      });
  }

  get name(): string {
    return this.spec.name;
  }

  getState(): ServiceState {
    return this.state;
  }

  markWaiting(): void {
    if (this.state === 'pending') this.setState('waiting');
  }

  start(): void {
    if (this.wantRunning) return;
    this.wantRunning = true;
    this.currentDelayMs = 0;
    this.launch();
  }

  async stop(): Promise<void> {
    this.wantRunning = false;
    this.abortProbe();
    if (this.retryTimer) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
    this.nextRetryAt = null;
    const child = this.child;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.setState('stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  getStatus(): ServiceStatus {
    return {
      name: this.spec.name,
      state: this.state,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      lastExitCode: this.lastExitCode,
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      nextRetryAt: this.nextRetryAt ? this.nextRetryAt.toISOString() : null,
      command: describeCommand(this.spec.command),
    };
  }

  tail(n: number): LogEvent[] {
    return this.ring.tail(n);
  }

  private setState(next: ServiceState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next);
  }

  private launch(): void {
    this.setState('starting');
    const spec = this.spec;
    const cwd = resolveCwd(spec.cwd, this.opts.cwd);

    if (!this.logStream) {
      this.logStream = createWriteStream(join(this.opts.logDir, `${spec.name}.log`), {
        flags: 'a',
      });
      this.logStream.on('error', (err) => {
        this.appendEvent('stderr', `[ctl] log write error: ${err.message}`);
      });
    }

    const { bin, args } = spawnArgs(spec.command);

    let child: ChildProcess;
    try {
      child = this.spawnFn(bin, args, {
        cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.appendEvent(
        'stderr',
        `[ctl] spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.onExit(-1, null);
      return;
    }

    this.child = child;
    this.startedAt = new Date();
    this.nextRetryAt = null;
    this.setState('running');

    const onLine = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        this.appendEvent(stream, line);
      }
    };
    child.stdout?.on('data', onLine('stdout'));
    child.stderr?.on('data', onLine('stderr'));

    child.on('exit', (code, signal) => {
      this.onExit(code, signal);
    });
    child.on('error', (err) => {
      this.appendEvent('stderr', `[ctl] child error: ${err.message}`);
    });

    if (this.spec.readyWhen) this.beginProbe();
  }

  private beginProbe(): void {
    this.abortProbe();
    const probe = this.spec.readyWhen;
    if (!probe) return;
    const handle = startProbe(probe, {
      subscribeLogs:
        probe.kind === 'log_match'
          ? (cb) => {
              this.on('log', cb);
              return () => this.off('log', cb);
            }
          : undefined,
    });
    this.currentProbe = handle;
    handle.result
      .then((res) => {
        if (handle !== this.currentProbe) return;
        if (res === 'aborted') return;
        if (res === 'ready') {
          this.currentProbe = null;
          this.setState('ready');
          return;
        }
        // timed_out
        this.currentProbe = null;
        if (probe.onTimeout === 'kill') {
          this.appendEvent(
            'stderr',
            `[ctl] readiness probe timed out after ${String(probe.timeoutMs)}ms; killing process`,
          );
          this.child?.kill('SIGTERM');
        } else {
          this.appendEvent(
            'stderr',
            `[ctl] readiness probe timed out after ${String(probe.timeoutMs)}ms; marking unhealthy`,
          );
          this.setState('unhealthy');
        }
      })
      .catch(() => {
        // Probe shouldn't throw, but be defensive.
        if (handle === this.currentProbe) this.currentProbe = null;
      });
  }

  private abortProbe(): void {
    if (this.currentProbe) {
      this.currentProbe.abort();
      this.currentProbe = null;
    }
  }

  private appendEvent(stream: 'stdout' | 'stderr', line: string): void {
    const ev: LogEvent = {
      service: this.spec.name,
      ts: new Date().toISOString(),
      stream,
      line,
    };
    this.ring.push(ev);
    this.logStream?.write(`${ev.ts}\t${stream}\t${line}\n`);
    this.emit('log', ev);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.lastExitCode = code;
    this.child = null;
    this.abortProbe();
    this.appendEvent('stderr', `[ctl] exited code=${String(code)} signal=${signal ?? 'none'}`);

    if (!this.wantRunning) {
      this.setState('stopped');
      return;
    }

    const policy = this.spec.restart;
    const shouldRetry = policy === 'always' || (policy === 'on-failure' && code !== 0);
    if (!shouldRetry) {
      this.setState(code === 0 ? 'stopped' : 'crashed');
      this.wantRunning = false;
      return;
    }

    this.restarts += 1;
    this.currentDelayMs = nextDelay(this.currentDelayMs, this.spec.backoff);
    this.nextRetryAt = new Date(Date.now() + this.currentDelayMs);
    this.setState('backoff');
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.wantRunning) this.launch();
    }, this.currentDelayMs);
  }
}

function nextDelay(prev: number, b: { initialMs: number; maxMs: number; factor: number }): number {
  if (prev === 0) return b.initialMs;
  return Math.min(prev * b.factor, b.maxMs);
}

export class TaskRunner extends EventEmitter<TaskRunnerEvents> implements Unit {
  readonly kind = 'task' as const;
  private state: TaskState = 'pending';
  private child: ChildProcess | null = null;
  private startedAt: Date | null = null;
  private finishedAt: Date | null = null;
  private lastExitCode: number | null = null;
  private logStream: WriteStream | null = null;
  private readonly ring = new Ring<LogEvent>(RING_SIZE);
  private readonly spawnFn: typeof spawn;

  constructor(
    public readonly spec: TaskSpec,
    private readonly opts: RunnerOptions,
  ) {
    super();
    this.spawnFn = opts.spawn ?? spawn;
  }

  get name(): string {
    return this.spec.name;
  }

  getState(): TaskState {
    return this.state;
  }

  tail(n: number): LogEvent[] {
    return this.ring.tail(n);
  }

  getStatus(): TaskStatus {
    return {
      name: this.spec.name,
      state: this.state,
      pid: this.child?.pid ?? null,
      lastExitCode: this.lastExitCode,
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      finishedAt: this.finishedAt ? this.finishedAt.toISOString() : null,
      command: describeCommand(this.spec.command),
    };
  }

  markWaiting(): void {
    if (this.state === 'pending') this.setState('waiting');
  }

  markSkipped(): void {
    if (this.state === 'pending' || this.state === 'waiting') this.setState('skipped');
  }

  start(): void {
    if (this.state !== 'pending' && this.state !== 'waiting') return;
    this.launch();
  }

  /**
   * Force the task back to pending so the scheduler can re-run it. Used by
   * reload when the spec changed, and (PR 5) by the run-task wire op.
   */
  resetForRerun(): void {
    if (this.state === 'running') return;
    this.state = 'pending';
    this.startedAt = null;
    this.finishedAt = null;
    this.lastExitCode = null;
    this.emit('state', this.state);
  }

  private setState(next: TaskState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next);
  }

  private launch(): void {
    const spec = this.spec;
    const cwd = resolveCwd(spec.cwd, this.opts.cwd);

    if (!this.logStream) {
      this.logStream = createWriteStream(join(this.opts.logDir, `${spec.name}.log`), {
        flags: 'a',
      });
      this.logStream.on('error', (err) => {
        this.appendEvent('stderr', `[ctl] log write error: ${err.message}`);
      });
    }

    const { bin, args } = spawnArgs(spec.command);

    let child: ChildProcess;
    try {
      child = this.spawnFn(bin, args, {
        cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.appendEvent(
        'stderr',
        `[ctl] spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.lastExitCode = -1;
      this.finishedAt = new Date();
      this.setState('failed');
      return;
    }

    this.child = child;
    this.startedAt = new Date();
    this.setState('running');

    const onLine = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        this.appendEvent(stream, line);
      }
    };
    child.stdout?.on('data', onLine('stdout'));
    child.stderr?.on('data', onLine('stderr'));

    child.on('exit', (code, signal) => {
      this.lastExitCode = code;
      this.finishedAt = new Date();
      this.child = null;
      this.appendEvent('stderr', `[ctl] exited code=${String(code)} signal=${signal ?? 'none'}`);
      this.setState(code === 0 ? 'done' : 'failed');
    });
    child.on('error', (err) => {
      this.appendEvent('stderr', `[ctl] child error: ${err.message}`);
    });
  }

  private appendEvent(stream: 'stdout' | 'stderr', line: string): void {
    const ev: LogEvent = {
      service: this.spec.name,
      ts: new Date().toISOString(),
      stream,
      line,
    };
    this.ring.push(ev);
    this.logStream?.write(`${ev.ts}\t${stream}\t${line}\n`);
    this.emit('log', ev);
  }
}

export interface SupervisorOptions {
  workspace: string;
  logDir: string;
  spawn?: typeof spawn;
}

interface SupervisorEvents {
  log: [LogEvent];
}

export class Supervisor extends EventEmitter<SupervisorEvents> {
  private units = new Map<string, Unit>();
  private deps = new Map<string, string[]>();
  private satisfied = new Set<string>();
  private failed = new Set<string>();
  private scheduling = false;
  private rescheduleDirty = false;

  constructor(private readonly opts: SupervisorOptions) {
    super();
  }

  async init(cfg: CtlConfig): Promise<void> {
    await mkdir(this.opts.logDir, { recursive: true });
    for (const t of cfg.tasks) this.addTaskUnit(t);
    for (const s of cfg.services) this.addServiceUnit(s);
    this.schedule();
  }

  private addServiceUnit(spec: ServiceSpec): ServiceRunner {
    const runner = new ServiceRunner(spec, {
      logDir: this.opts.logDir,
      cwd: this.opts.workspace,
      spawn: this.opts.spawn,
    });
    runner.on('log', (ev) => this.emit('log', ev));
    runner.on('state', (s) => this.onServiceState(runner.name, s));
    this.units.set(spec.name, runner);
    this.deps.set(spec.name, spec.needs);
    return runner;
  }

  private addTaskUnit(spec: TaskSpec): TaskRunner {
    const runner = new TaskRunner(spec, {
      logDir: this.opts.logDir,
      cwd: this.opts.workspace,
      spawn: this.opts.spawn,
    });
    runner.on('log', (ev) => this.emit('log', ev));
    runner.on('state', (s) => this.onTaskState(runner.name, s));
    this.units.set(spec.name, runner);
    this.deps.set(spec.name, spec.needs);
    return runner;
  }

  list(): ServiceStatus[] {
    const out: ServiceStatus[] = [];
    for (const u of this.units.values()) {
      if (u.kind === 'service') out.push((u as ServiceRunner).getStatus());
    }
    return out;
  }

  listTasks(): TaskStatus[] {
    const out: TaskStatus[] = [];
    for (const u of this.units.values()) {
      if (u.kind === 'task') out.push((u as TaskRunner).getStatus());
    }
    return out;
  }

  get(name: string): ServiceRunner | undefined {
    const u = this.units.get(name);
    return u && u.kind === 'service' ? (u as ServiceRunner) : undefined;
  }

  getTask(name: string): TaskRunner | undefined {
    const u = this.units.get(name);
    return u && u.kind === 'task' ? (u as TaskRunner) : undefined;
  }

  async stopAll(): Promise<void> {
    const services: ServiceRunner[] = [];
    for (const u of this.units.values()) {
      if (u.kind === 'service') services.push(u as ServiceRunner);
    }
    await Promise.all(services.map((r) => r.stop()));
  }

  /**
   * Replace the current config. Existing tasks/services with unchanged spec
   * keep their state; changed services are stopped and respawned; changed
   * tasks are reset to pending and rerun if they have dependents being
   * scheduled. Removed units are stopped (services) or deleted (tasks).
   */
  async reload(next: CtlConfig): Promise<{ added: string[]; removed: string[]; changed: string[] }> {
    const nextServices = new Map(next.services.map((s) => [s.name, s]));
    const nextTasks = new Map(next.tasks.map((t) => [t.name, t]));
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    for (const [name, unit] of [...this.units]) {
      if (unit.kind === 'service' && !nextServices.has(name)) {
        await (unit as ServiceRunner).stop();
        this.dropUnit(name);
        removed.push(name);
      } else if (unit.kind === 'task' && !nextTasks.has(name)) {
        this.dropUnit(name);
        removed.push(name);
      }
    }

    for (const spec of next.services) {
      const existing = this.units.get(spec.name);
      if (!existing) {
        this.addServiceUnit(spec);
        added.push(spec.name);
        continue;
      }
      if (existing.kind !== 'service') continue;
      const existingRunner = existing as ServiceRunner;
      if (!serviceSpecsEqual(existingRunner.spec, spec)) {
        await existingRunner.stop();
        this.dropUnit(spec.name);
        this.addServiceUnit(spec);
        changed.push(spec.name);
      }
    }

    for (const spec of next.tasks) {
      const existing = this.units.get(spec.name);
      if (!existing) {
        this.addTaskUnit(spec);
        added.push(spec.name);
        continue;
      }
      if (existing.kind !== 'task') continue;
      const existingTask = existing as TaskRunner;
      if (!taskSpecsEqual(existingTask.spec, spec)) {
        this.dropUnit(spec.name);
        this.addTaskUnit(spec);
        changed.push(spec.name);
      }
    }

    this.schedule();
    return { added, removed, changed };
  }

  private dropUnit(name: string): void {
    this.units.delete(name);
    this.deps.delete(name);
    this.satisfied.delete(name);
    this.failed.delete(name);
  }

  private onTaskState(name: string, state: TaskState): void {
    if (state === 'done') {
      this.satisfied.add(name);
      this.schedule();
    } else if (state === 'failed' || state === 'skipped') {
      this.failed.add(name);
      this.schedule();
    } else if (state === 'pending') {
      // resetForRerun() — eligibility regained.
      this.satisfied.delete(name);
      this.failed.delete(name);
      this.schedule();
    }
  }

  private onServiceState(name: string, state: ServiceState): void {
    const unit = this.units.get(name);
    if (unit?.kind !== 'service') return;
    const service = unit as ServiceRunner;
    const satisfiedState: ServiceState = service.spec.readyWhen ? 'ready' : 'running';

    if (state === satisfiedState) {
      if (!this.satisfied.has(name)) {
        this.satisfied.add(name);
        this.schedule();
      }
      return;
    }
    if (state === 'crashed' && !this.satisfied.has(name)) {
      this.failed.add(name);
      this.schedule();
    }
  }

  /**
   * Re-evaluate every pending/waiting unit against the satisfied/failed sets.
   * Reentrant-safe: nested calls (triggered by synchronous state events) just
   * flag the outer loop to iterate once more.
   */
  private schedule(): void {
    this.rescheduleDirty = true;
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      while (this.rescheduleDirty) {
        this.rescheduleDirty = false;
        this.scheduleOnce();
      }
    } finally {
      this.scheduling = false;
    }
  }

  private scheduleOnce(): void {
    for (const [name, unit] of this.units) {
      const needs = this.deps.get(name) ?? [];

      if (unit.kind === 'task') {
        const task = unit as TaskRunner;
        const s = task.getState();
        if (s !== 'pending' && s !== 'waiting') continue;

        if (needs.some((d) => this.failed.has(d))) {
          task.markSkipped();
          continue;
        }
        if (needs.every((d) => this.satisfied.has(d))) {
          task.start();
        } else {
          task.markWaiting();
        }
      } else {
        const service = unit as ServiceRunner;
        const s = service.getState();
        if (s !== 'pending' && s !== 'waiting') continue;
        if (!service.spec.autostart) continue;

        if (needs.some((d) => this.failed.has(d))) {
          // No 'skipped' state for services in PR 3 — they sit in 'waiting'
          // until the user investigates. PR 5 will surface the blocking dep
          // in the status payload.
          service.markWaiting();
          continue;
        }
        if (needs.every((d) => this.satisfied.has(d))) {
          service.start();
        } else {
          service.markWaiting();
        }
      }
    }
  }
}

function serviceSpecsEqual(a: ServiceSpec, b: ServiceSpec): boolean {
  return JSON.stringify(normalizeService(a)) === JSON.stringify(normalizeService(b));
}

function normalizeService(s: ServiceSpec): unknown {
  return {
    name: s.name,
    command: s.command,
    cwd: s.cwd ?? null,
    env: s.env ?? null,
    restart: s.restart,
    autostart: s.autostart,
    backoff: s.backoff,
    needs: [...s.needs].sort(),
    readyWhen: serializeProbe(s.readyWhen),
  };
}

function serializeProbe(p: ServiceSpec['readyWhen']): unknown {
  if (!p) return null;
  if (p.kind === 'log_match') {
    return { kind: 'log_match', source: p.pattern.source, flags: p.pattern.flags, timeoutMs: p.timeoutMs, onTimeout: p.onTimeout };
  }
  return p;
}

function taskSpecsEqual(a: TaskSpec, b: TaskSpec): boolean {
  return JSON.stringify(normalizeTask(a)) === JSON.stringify(normalizeTask(b));
}

function normalizeTask(t: TaskSpec): unknown {
  return {
    name: t.name,
    command: t.command,
    cwd: t.cwd ?? null,
    env: t.env ?? null,
    needs: [...t.needs].sort(),
  };
}

export async function readLogFile(
  logDir: string,
  service: string,
  tail: number,
): Promise<LogEvent[]> {
  const path = join(logDir, `${service}.log`);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const lines = text.split('\n').filter((l) => l.length > 0);
  const slice = tail >= lines.length ? lines : lines.slice(lines.length - tail);
  const events: LogEvent[] = [];
  for (const line of slice) {
    const [ts, stream, ...rest] = line.split('\t');
    if (!ts || (stream !== 'stdout' && stream !== 'stderr')) continue;
    events.push({ service, ts, stream, line: rest.join('\t') });
  }
  return events;
}
