import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Supervisor } from '../src/supervisor.js';
import type { CtlConfig, ServiceSpec, TaskSpec } from '../src/config.js';

const NODE = process.execPath;

function spec(
  over: Partial<ServiceSpec> & { name: string; command: string | string[] },
): ServiceSpec {
  return {
    autostart: true,
    restart: 'on-failure',
    backoff: { initialMs: 10, maxMs: 50, factor: 2 },
    needs: [],
    ...over,
  };
}

function taskSpec(over: Partial<TaskSpec> & { name: string; command: string | string[] }): TaskSpec {
  return { needs: [], ...over };
}

function cfg(services: ServiceSpec[], tasks: TaskSpec[] = []): CtlConfig {
  return { services, tasks, replacements: {} };
}

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

describe('Supervisor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ctl-sup-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a service and reports running state with a pid', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init(
      cfg([
        spec({
          name: 'hello',
          command: [NODE, '-e', 'setInterval(()=>console.log("tick"),50)'],
        }),
      ]),
    );
    const status = await waitFor(() => {
      const s = sup.list()[0]!;
      return s.state === 'running' ? s : null;
    });
    expect(status.pid).toBeTypeOf('number');
    await sup.stopAll();
  });

  it('restarts on crash under on-failure policy', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init(
      cfg([
        spec({
          name: 'crashy',
          command: [NODE, '-e', 'process.exit(1)'],
        }),
      ]),
    );
    const after = await waitFor(() => {
      const s = sup.list()[0]!;
      return s.restarts >= 2 ? s : null;
    }, 3000);
    expect(after.restarts).toBeGreaterThanOrEqual(2);
    await sup.stopAll();
  });

  it('honours restart: never', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init(
      cfg([
        spec({
          name: 'one-shot',
          command: [NODE, '-e', 'process.exit(1)'],
          restart: 'never',
        }),
      ]),
    );
    const final = await waitFor(() => {
      const s = sup.list()[0]!;
      return s.state === 'crashed' ? s : null;
    });
    expect(final.restarts).toBe(0);
    await sup.stopAll();
  });

  it('captures stdout into the log ring', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init(
      cfg([
        spec({
          name: 'noisy',
          command: [NODE, '-e', 'console.log("hello"); setTimeout(()=>{}, 200)'],
          restart: 'never',
        }),
      ]),
    );
    const lines = await waitFor(() => {
      const r = sup.get('noisy')!;
      const tail = r.tail(50);
      return tail.find((e) => e.stream === 'stdout' && e.line === 'hello') ? tail : null;
    });
    expect(lines.some((e) => e.line === 'hello')).toBe(true);
    await sup.stopAll();
  });

  it('reload diffs services and stops removed ones', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init(
      cfg([
        spec({ name: 'a', command: [NODE, '-e', 'setInterval(()=>{},1000)'] }),
        spec({ name: 'b', command: [NODE, '-e', 'setInterval(()=>{},1000)'] }),
      ]),
    );
    await waitFor(() => sup.list().every((s) => s.state === 'running') || null);

    const diff = await sup.reload(
      cfg([
        spec({ name: 'a', command: [NODE, '-e', 'setInterval(()=>{},1000)'] }),
        spec({ name: 'c', command: [NODE, '-e', 'setInterval(()=>{},1000)'] }),
      ]),
    );
    expect(diff.removed).toEqual(['b']);
    expect(diff.added).toEqual(['c']);
    expect(diff.changed).toEqual([]);
    expect(sup.get('b')).toBeUndefined();
    await sup.stopAll();
  });

  it('runs a task and marks it done', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init(
      cfg(
        [],
        [taskSpec({ name: 'build', command: [NODE, '-e', 'process.exit(0)'] })],
      ),
    );
    const done = await waitFor(() => {
      const t = sup.listTasks()[0]!;
      return t.state === 'done' ? t : null;
    });
    expect(done.lastExitCode).toBe(0);
  });

  it('marks a failing task as failed', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init(
      cfg(
        [],
        [taskSpec({ name: 'broken', command: [NODE, '-e', 'process.exit(7)'] })],
      ),
    );
    const failed = await waitFor(() => {
      const t = sup.listTasks()[0]!;
      return t.state === 'failed' ? t : null;
    });
    expect(failed.lastExitCode).toBe(7);
  });

  it('service with needs on a task waits, then starts when task completes', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init(
      cfg(
        [
          spec({
            name: 'api',
            command: [NODE, '-e', 'setInterval(()=>{},1000)'],
            needs: ['build'],
          }),
        ],
        [
          taskSpec({
            name: 'build',
            command: [NODE, '-e', 'setTimeout(() => process.exit(0), 80)'],
          }),
        ],
      ),
    );
    // Immediately after init, the service should be waiting on the task.
    const waitingState = sup.list()[0]!.state;
    expect(['waiting', 'pending']).toContain(waitingState);

    const running = await waitFor(() => {
      const s = sup.list()[0]!;
      return s.state === 'running' ? s : null;
    }, 3000);
    expect(running.pid).toBeTypeOf('number');
    expect(sup.listTasks()[0]!.state).toBe('done');
    await sup.stopAll();
  });

  it('service with autostart:false stays pending', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init(
      cfg([
        spec({
          name: 'manual',
          command: [NODE, '-e', 'setInterval(()=>{},1000)'],
          autostart: false,
        }),
      ]),
    );
    // Give the scheduler a tick; nothing should have started.
    await new Promise((r) => setTimeout(r, 30));
    expect(sup.list()[0]!.state).toBe('pending');
    await sup.stopAll();
  });

  it('downstream task is skipped when upstream task fails', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init(
      cfg(
        [],
        [
          taskSpec({ name: 'broken', command: [NODE, '-e', 'process.exit(1)'] }),
          taskSpec({
            name: 'after',
            command: [NODE, '-e', 'process.exit(0)'],
            needs: ['broken'],
          }),
        ],
      ),
    );
    const after = await waitFor(() => {
      const t = sup.listTasks().find((x) => x.name === 'after');
      return t && t.state === 'skipped' ? t : null;
    }, 3000);
    expect(after.lastExitCode).toBeNull();
  });

  it('reload re-queues a skipped task once its failed dependency is fixed', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init(
      cfg(
        [],
        [
          taskSpec({ name: 'broken', command: [NODE, '-e', 'process.exit(1)'] }),
          taskSpec({
            name: 'after',
            command: [NODE, '-e', 'process.exit(0)'],
            needs: ['broken'],
          }),
        ],
      ),
    );
    await waitFor(() => {
      const t = sup.listTasks().find((x) => x.name === 'after');
      return t && t.state === 'skipped' ? t : null;
    }, 3000);

    // User fixes the failing dependency and reloads (the setup-iteration loop).
    await sup.reload(
      cfg(
        [],
        [
          taskSpec({ name: 'broken', command: [NODE, '-e', 'process.exit(0)'] }),
          taskSpec({
            name: 'after',
            command: [NODE, '-e', 'process.exit(0)'],
            needs: ['broken'],
          }),
        ],
      ),
    );

    const after = await waitFor(() => {
      const t = sup.listTasks().find((x) => x.name === 'after');
      return t && t.state === 'done' ? t : null;
    }, 3000);
    expect(after.lastExitCode).toBe(0);
  });

  it('service with port probe transitions running → ready and unblocks dependents', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    // Pick an unlikely-to-be-used high port.
    const port = 23000 + Math.floor(Math.random() * 2000);
    await sup.init(
      cfg([
        spec({
          name: 'api',
          command: [
            NODE,
            '-e',
            `setTimeout(() => require('http').createServer((_,r)=>r.end('ok')).listen(${String(port)}), 100)`,
          ],
          readyWhen: {
            kind: 'port',
            port,
            host: '127.0.0.1',
            intervalMs: 30,
            initialDelayMs: 0,
            timeoutMs: 3000,
            onTimeout: 'kill',
          },
        }),
        spec({
          name: 'downstream',
          command: [NODE, '-e', 'setInterval(()=>{},1000)'],
          needs: ['api'],
        }),
      ]),
    );

    const ready = await waitFor(() => {
      const s = sup.list().find((x) => x.name === 'api');
      return s && s.state === 'ready' ? s : null;
    }, 5000);
    expect(ready.state).toBe('ready');

    const dsRunning = await waitFor(() => {
      const s = sup.list().find((x) => x.name === 'downstream');
      return s && s.state === 'running' ? s : null;
    }, 3000);
    expect(dsRunning.state).toBe('running');

    await sup.stopAll();
  });

  it('service is killed when probe times out with on_timeout: kill (restart=never)', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    const port = 24000 + Math.floor(Math.random() * 2000);
    await sup.init(
      cfg([
        spec({
          name: 'never-ready',
          // Process stays alive but never opens the port.
          command: [NODE, '-e', 'setInterval(()=>{},1000)'],
          restart: 'never',
          readyWhen: {
            kind: 'port',
            port,
            host: '127.0.0.1',
            intervalMs: 30,
            initialDelayMs: 0,
            timeoutMs: 200,
            onTimeout: 'kill',
          },
        }),
      ]),
    );
    const final = await waitFor(() => {
      const s = sup.list()[0]!;
      // Probe timed out → SIGTERM → exit non-zero → crashed (restart=never).
      return s.state === 'crashed' ? s : null;
    }, 3000);
    expect(final.state).toBe('crashed');
  });

  it('service is marked unhealthy when probe times out with on_timeout: mark_unhealthy', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    const port = 26000 + Math.floor(Math.random() * 2000);
    await sup.init(
      cfg([
        spec({
          name: 'slow-warmup',
          command: [NODE, '-e', 'setInterval(()=>{},1000)'],
          restart: 'never',
          readyWhen: {
            kind: 'port',
            port,
            host: '127.0.0.1',
            intervalMs: 30,
            initialDelayMs: 0,
            timeoutMs: 200,
            onTimeout: 'mark_unhealthy',
          },
        }),
      ]),
    );
    const final = await waitFor(() => {
      const s = sup.list()[0]!;
      return s.state === 'unhealthy' ? s : null;
    }, 3000);
    expect(final.state).toBe('unhealthy');
    await sup.stopAll();
  });

  it('concurrent independent tasks run in parallel', async () => {
    const sup = new Supervisor({ workspace: dir, logDir: dir });
    const start = Date.now();
    // Per-task delay sized so the gap between sequential (≥1600ms + 2× spawn,
    // typically 1700–1900ms) and parallel (~800ms + spawn, typically 900–1200ms)
    // is large enough to survive CI runner noise. The 700ms threshold from a
    // 400ms-per-task version flaked at 733ms on a slow GitHub Actions runner;
    // doubling the task delay buys ~600ms of headroom without losing the
    // parallelism signal.
    await sup.init(
      cfg(
        [],
        [
          taskSpec({
            name: 't1',
            command: [NODE, '-e', 'setTimeout(()=>process.exit(0), 800)'],
          }),
          taskSpec({
            name: 't2',
            command: [NODE, '-e', 'setTimeout(()=>process.exit(0), 800)'],
          }),
        ],
      ),
    );
    await waitFor(() => sup.listTasks().every((t) => t.state === 'done') || null, 5000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1400);
  });
});
