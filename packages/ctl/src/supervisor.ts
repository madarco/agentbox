import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  describeCommand,
  type CtlConfig,
  type ExposeSpec,
  type ServiceSpec,
  type TaskSpec,
} from './config.js';
import { startProbe, type ProbeHandle } from './probe.js';
import { RelayClient } from './relay-client.js';
import { WebProxy } from './web-proxy.js';
import type {
  LogEvent,
  ServiceState,
  ServiceStatus,
  TaskState,
  TaskStatus,
  WaitReadyArgs,
  WaitReadyReply,
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

let cachedLoginPath: string | undefined;

/**
 * The PATH a `bash -l` interactive shell sees inside the box. The supervisor is
 * launched via `docker exec` (no profile sourcing), so without this, tasks and
 * services run with a thinner PATH than `agentbox shell` — tools the native
 * installer drops in ~/.local/bin (and the box's pnpm wrapper) would be missed.
 * Resolved once, lazily, and memoized; falls back to the supervisor's own PATH.
 */
function loginShellPath(): string {
  if (cachedLoginPath !== undefined) return cachedLoginPath;
  try {
    const out = execFileSync('bash', ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    cachedLoginPath = out || (process.env.PATH ?? '');
  } catch {
    cachedLoginPath = process.env.PATH ?? '';
  }
  return cachedLoginPath;
}

export class ServiceRunner extends EventEmitter<ServiceRunnerEvents> implements Unit {
  readonly kind = 'service' as const;
  private state: ServiceState = 'pending';
  private child: ChildProcess | null = null;
  private restarts = 0;
  private lastExitCode: number | null = null;
  private startedAt: Date | null = null;
  private readyAt: Date | null = null;
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

  getStatus(blockedOn: string[] = []): ServiceStatus {
    return {
      name: this.spec.name,
      state: this.state,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      lastExitCode: this.lastExitCode,
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      readyAt: this.readyAt ? this.readyAt.toISOString() : null,
      nextRetryAt: this.nextRetryAt ? this.nextRetryAt.toISOString() : null,
      blockedOn,
      command: describeCommand(this.spec.command),
    };
  }

  tail(n: number): LogEvent[] {
    return this.ring.tail(n);
  }

  private setState(next: ServiceState): void {
    if (this.state === next) return;
    this.state = next;
    // Stamp readyAt when the service first becomes available — either reaching
    // 'running' for unprobed services, or 'ready' for probed ones.
    if (
      (next === 'running' && !this.spec.readyWhen) ||
      next === 'ready'
    ) {
      this.readyAt = new Date();
    }
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
        env: { ...process.env, PATH: loginShellPath(), ...(spec.env ?? {}) },
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
        env: { ...process.env, PATH: loginShellPath(), ...(spec.env ?? {}) },
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
  /**
   * Port the in-box WebProxy binds (forwarding to the `expose:` service).
   * Defaults to 80 (docker/hetzner/daytona). Cloud backends that can't expose a
   * privileged port — Vercel rejects <1024 — set this to a non-privileged port
   * (8080) via AGENTBOX_WEB_PROXY_PORT so the WebProxy is reachable at all.
   */
  webProxyPort?: number;
}

interface SupervisorEvents {
  log: [LogEvent];
  change: [];
}

// State transitions the supervisor forwards to the host relay. We keep this
// narrow on purpose — every transition is a host-facing event, so spammy
// intermediate states like 'starting' would just be noise.
const PUSHED_SERVICE_STATES: ReadonlySet<ServiceState> = new Set<ServiceState>([
  'ready',
  'running',
  'crashed',
  'backoff',
  'unhealthy',
  'stopped',
]);

const PUSHED_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'done',
  'failed',
  'skipped',
]);

export class Supervisor extends EventEmitter<SupervisorEvents> {
  private units = new Map<string, Unit>();
  private deps = new Map<string, string[]>();
  private satisfied = new Set<string>();
  private failed = new Set<string>();
  private scheduling = false;
  private rescheduleDirty = false;
  private readonly relay: RelayClient;
  private readonly webProxy: WebProxy;

  constructor(private readonly opts: SupervisorOptions) {
    super();
    this.relay = new RelayClient();
    this.webProxy = new WebProxy(opts.webProxyPort);
  }

  /** The relay client the supervisor pushes state events on. Shared with the
   * status reporter so both use the same fire-and-forget channel. */
  get relayClient(): RelayClient {
    return this.relay;
  }

  /**
   * Map of service name -> configured `ready_when` port, for services that
   * declare a port probe. Used by the status reporter to label discovered
   * listening ports with their owning service.
   */
  serviceProbePorts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const u of this.units.values()) {
      if (u.kind !== 'service') continue;
      const probe = (u as ServiceRunner).spec.readyWhen;
      if (probe && probe.kind === 'port') out.set(u.name, probe.port);
    }
    return out;
  }

  /**
   * Map of service name -> `expose:` mapping, for the (at most one) service
   * that declares it. The status reporter surfaces this so the host knows the
   * web service even when `agentbox.yaml` lives only inside the box.
   */
  serviceExposes(): Map<string, ExposeSpec> {
    const out = new Map<string, ExposeSpec>();
    for (const u of this.units.values()) {
      if (u.kind !== 'service') continue;
      const expose = (u as ServiceRunner).spec.expose;
      if (expose) out.set(u.name, expose);
    }
    return out;
  }

  /** (Re)point the in-box :80 forwarder at the `expose:`-flagged service. */
  private applyWebProxy(): void {
    const [first] = this.serviceExposes().values();
    this.webProxy.reconfigure(first ? first.port : null);
  }

  async init(cfg: CtlConfig): Promise<void> {
    await mkdir(this.opts.logDir, { recursive: true });
    for (const t of cfg.tasks) this.addTaskUnit(t);
    for (const s of cfg.services) this.addServiceUnit(s);
    this.applyWebProxy();
    this.schedule();
  }

  private emitChange(): void {
    this.emit('change');
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
      if (u.kind === 'service') {
        out.push((u as ServiceRunner).getStatus(this.computeBlockedOn(u.name)));
      }
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

  private computeBlockedOn(name: string): string[] {
    const unit = this.units.get(name);
    if (!unit) return [];
    const needs = this.deps.get(name) ?? [];
    if (needs.length === 0) return [];
    if (unit.kind === 'service') {
      const s = (unit as ServiceRunner).getState();
      if (s !== 'pending' && s !== 'waiting') return [];
    } else {
      const s = (unit as TaskRunner).getState();
      if (s !== 'pending' && s !== 'waiting') return [];
    }
    return needs.filter((d) => !this.satisfied.has(d));
  }

  async waitReady(args: WaitReadyArgs): Promise<WaitReadyReply> {
    const targets = args.units && args.units.length > 0 ? args.units : this.autostartNames();
    const timeoutMs = args.timeoutMs ?? 60_000;
    if (targets.length === 0 || this.areAllReady(targets)) return { ready: true };

    return new Promise<WaitReadyReply>((resolve) => {
      const onChange = (): void => {
        if (this.areAllReady(targets)) {
          cleanup();
          resolve({ ready: true });
        }
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('change', onChange);
      };
      const timer = setTimeout(() => {
        cleanup();
        const d = this.diagnose(targets);
        resolve({ ready: false, timedOut: d.notYet, failed: d.failed });
      }, timeoutMs);
      this.on('change', onChange);
    });
  }

  async runTask(name: string, force?: boolean): Promise<TaskStatus> {
    const t = this.getTask(name);
    if (!t) throw new Error(`unknown task: ${name}`);
    if (t.getState() === 'done' && !force) return t.getStatus();
    if (t.getState() === 'running') return t.getStatus();
    t.resetForRerun();
    this.schedule();
    return t.getStatus();
  }

  private autostartNames(): string[] {
    const out: string[] = [];
    for (const u of this.units.values()) {
      if (u.kind === 'task') out.push(u.name);
      else if ((u as ServiceRunner).spec.autostart) out.push(u.name);
    }
    return out;
  }

  private areAllReady(targets: string[]): boolean {
    for (const name of targets) {
      if (this.failed.has(name)) return false;
      if (!this.satisfied.has(name)) return false;
    }
    return true;
  }

  private diagnose(targets: string[]): { notYet: string[]; failed: string[] } {
    const notYet: string[] = [];
    const failed: string[] = [];
    for (const name of targets) {
      if (this.failed.has(name)) failed.push(name);
      else if (!this.satisfied.has(name)) notYet.push(name);
    }
    return { notYet, failed };
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
    this.webProxy.stop();
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

    // A task skipped because a dependency failed stays terminal otherwise:
    // scheduleOnce only re-evaluates pending/waiting units. On reload (the
    // setup-iteration loop where the user just fixed the failing dependency)
    // reset every still-skipped task to pending so the scheduler re-runs it if
    // the dependency now succeeds, or re-skips it if it still fails.
    for (const [name, unit] of this.units) {
      if (unit.kind !== 'task') continue;
      const task = unit as TaskRunner;
      if (task.getState() === 'skipped') {
        this.failed.delete(name);
        task.resetForRerun();
      }
    }

    this.applyWebProxy();
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
    if (this.relay.enabled && PUSHED_TASK_STATES.has(state)) {
      this.relay.post('task-state', { task: name, state });
    }
    this.emitChange();
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
    } else if (state === 'crashed' && !this.satisfied.has(name)) {
      this.failed.add(name);
      this.schedule();
    }
    if (this.relay.enabled && PUSHED_SERVICE_STATES.has(state)) {
      this.relay.post('service-state', { service: name, state });
    }
    this.emitChange();
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
    expose: s.expose ?? null,
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
