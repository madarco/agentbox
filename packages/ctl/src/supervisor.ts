import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeCommand, type ServiceSpec } from './config.js';
import type { LogEvent, ServiceState, ServiceStatus } from './types.js';

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
  /**
   * Override for tests: spawn returns a ChildProcess-like object.
   */
  spawn?: typeof spawn;
  /**
   * Override for tests: a setTimeout-equivalent. Returns a handle the runner
   * can cancel via clearTimer.
   */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (h: NodeJS.Timeout) => void;
}

interface RunnerEvents {
  log: [LogEvent];
  state: [ServiceState];
}

/**
 * Common shape for anything the Supervisor schedules. Tasks (PR 3) and
 * services share a name-space; the `kind` discriminator lets callers narrow.
 */
export interface Unit {
  readonly kind: 'task' | 'service';
  readonly name: string;
}

export class ServiceRunner extends EventEmitter<RunnerEvents> implements Unit {
  readonly kind = 'service' as const;
  get name(): string {
    return this.spec.name;
  }

  private state: ServiceState = 'stopped';
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

  start(): void {
    if (this.wantRunning) return;
    this.wantRunning = true;
    this.currentDelayMs = 0;
    this.launch();
  }

  async stop(): Promise<void> {
    this.wantRunning = false;
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
    const cwd = spec.cwd
      ? spec.cwd.startsWith('/')
        ? spec.cwd
        : join(this.opts.cwd, spec.cwd)
      : this.opts.cwd;

    if (!this.logStream) {
      this.logStream = createWriteStream(join(this.opts.logDir, `${spec.name}.log`), {
        flags: 'a',
      });
      // Surface stream errors as log lines so the supervisor stays up if the
      // log file becomes unwritable.
      this.logStream.on('error', (err) => {
        this.appendEvent('stderr', `[ctl] log write error: ${err.message}`);
      });
    }

    const useShell = typeof spec.command === 'string';
    const args = useShell ? ['-c', spec.command as string] : (spec.command as string[]).slice(1);
    const cmd = useShell ? 'bash' : (spec.command as string[])[0]!;

    let child: ChildProcess;
    try {
      child = this.spawnFn(cmd, args, {
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

  constructor(private readonly opts: SupervisorOptions) {
    super();
  }

  async init(specs: ServiceSpec[]): Promise<void> {
    await mkdir(this.opts.logDir, { recursive: true });
    for (const spec of specs) this.addServiceUnit(spec);
    for (const u of this.units.values()) {
      if (u.kind === 'service' && (u as ServiceRunner).spec.autostart) {
        (u as ServiceRunner).start();
      }
    }
  }

  private addServiceUnit(spec: ServiceSpec): ServiceRunner {
    const runner = new ServiceRunner(spec, {
      logDir: this.opts.logDir,
      cwd: this.opts.workspace,
      spawn: this.opts.spawn,
    });
    runner.on('log', (ev) => this.emit('log', ev));
    this.units.set(spec.name, runner);
    return runner;
  }

  list(): ServiceStatus[] {
    const out: ServiceStatus[] = [];
    for (const u of this.units.values()) {
      if (u.kind === 'service') out.push((u as ServiceRunner).getStatus());
    }
    return out;
  }

  get(name: string): ServiceRunner | undefined {
    const u = this.units.get(name);
    return u && u.kind === 'service' ? (u as ServiceRunner) : undefined;
  }

  async stopAll(): Promise<void> {
    const services: ServiceRunner[] = [];
    for (const u of this.units.values()) {
      if (u.kind === 'service') services.push(u as ServiceRunner);
    }
    await Promise.all(services.map((r) => r.stop()));
  }

  /**
   * Replace the current set of services with `next`. Existing services with
   * the same name and identical command/restart spec are left running; changed
   * specs are stopped and restarted; removed services are stopped.
   */
  async reload(
    next: ServiceSpec[],
  ): Promise<{ added: string[]; removed: string[]; changed: string[] }> {
    const nextByName = new Map(next.map((s) => [s.name, s]));
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    for (const [name, unit] of this.units) {
      if (unit.kind !== 'service') continue;
      if (!nextByName.has(name)) {
        await (unit as ServiceRunner).stop();
        this.units.delete(name);
        removed.push(name);
      }
    }

    for (const spec of next) {
      const existing = this.units.get(spec.name);
      if (!existing) {
        const runner = this.addServiceUnit(spec);
        if (spec.autostart) runner.start();
        added.push(spec.name);
        continue;
      }
      if (existing.kind !== 'service') continue;
      const existingRunner = existing as ServiceRunner;
      if (!specsEqual(existingRunner.spec, spec)) {
        await existingRunner.stop();
        this.units.delete(spec.name);
        const runner = this.addServiceUnit(spec);
        if (spec.autostart) runner.start();
        changed.push(spec.name);
      }
    }

    return { added, removed, changed };
  }
}

function specsEqual(a: ServiceSpec, b: ServiceSpec): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(s: ServiceSpec): unknown {
  return {
    name: s.name,
    command: s.command,
    cwd: s.cwd ?? null,
    env: s.env ?? null,
    restart: s.restart,
    autostart: s.autostart,
    backoff: s.backoff,
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
