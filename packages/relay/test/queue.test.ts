import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countInFlightCreateJobs,
  countRunningPrepareJobs,
  countWorkingSlots,
  defaultCountWorkingBoxes,
  loadQueue,
  occupiesWorkingSlot,
  PREPARE_MAX_CONCURRENT,
  selectNextRunnable,
  selectNextRunnableByWorking,
  selectNextRunnablePrepare,
  startQueueLoop,
  STARTUP_GRACE_MS,
  writeJob,
  type QueueConfig,
  type QueueJob,
  type WorkingSlotEntry,
} from '../src/queue.js';
import { BoxRegistry } from '../src/registry.js';
import type { BoxStatusStore } from '../src/status-store.js';

function job(p: Partial<QueueJob> & { id: string }): QueueJob {
  return {
    agent: 'claude-code',
    status: 'queued',
    boxName: '',
    providerName: 'docker',
    prompt: 'hi',
    agentArgs: [],
    createOpts: { workspace: '/ws' },
    maxConcurrent: 5,
    createdAt: '2024-01-01T00:00:00.000Z',
    logPath: '/tmp/log',
    ...p,
  };
}

describe('selectNextRunnable', () => {
  it('returns null on an empty list', () => {
    expect(selectNextRunnable([], 0)).toBeNull();
  });

  it('returns the oldest queued job when running is below ceiling', () => {
    const jobs = [
      job({ id: 'a', createdAt: '2024-01-01T00:00:01.000Z' }),
      job({ id: 'b', createdAt: '2024-01-01T00:00:00.000Z' }),
      job({ id: 'c', createdAt: '2024-01-01T00:00:02.000Z' }),
    ].sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
    // loadQueue sorts ascending — this test gets the same shape.
    expect(selectNextRunnable(jobs, 0)?.id).toBe('b');
  });

  it('respects per-job maxConcurrent: a higher --max-running override starts when the global wouldn\'t', () => {
    const jobs = [
      // The default ceiling is 1; this job overrode to 3.
      job({ id: 'override', maxConcurrent: 3 }),
    ];
    // 2 boxes running. Without the override (1) it would skip. With (3), it starts.
    expect(selectNextRunnable(jobs, 2)?.id).toBe('override');
  });

  it('skips queued jobs whose per-job ceiling is exceeded but picks a later one with a higher ceiling', () => {
    const jobs = [
      job({ id: 'small', maxConcurrent: 1, createdAt: '2024-01-01T00:00:00.000Z' }),
      job({ id: 'big', maxConcurrent: 5, createdAt: '2024-01-01T00:00:01.000Z' }),
    ];
    // 2 running: small (cap 1) blocked, big (cap 5) startable.
    expect(selectNextRunnable(jobs, 2)?.id).toBe('big');
  });

  it('ignores non-queued statuses (running/done/failed/cancelled)', () => {
    const jobs = [
      job({ id: 'r', status: 'running' }),
      job({ id: 'd', status: 'done' }),
      job({ id: 'f', status: 'failed' }),
      job({ id: 'c', status: 'cancelled' }),
      job({ id: 'q', status: 'queued', createdAt: '2024-01-02T00:00:00.000Z' }),
    ];
    expect(selectNextRunnable(jobs, 0)?.id).toBe('q');
  });

  it('returns null when nothing can start right now', () => {
    const jobs = [job({ id: 'tight', maxConcurrent: 1 })];
    expect(selectNextRunnable(jobs, 1)).toBeNull();
  });
});

describe('startQueueLoop', () => {
  it('skips ticks when disabled', async () => {
    let spawned = 0;
    const handle = startQueueLoop({
      log: () => {},
      loadConfig: async () => ({ enabled: false, maxConcurrent: 1, maxWorking: 0, idleGraceMs: 15_000 }),
      countRunning: async () => 0,
      spawnWorker: async () => {
        spawned += 1;
        return 123;
      },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 50));
    await handle.stop();
    expect(spawned).toBe(0);
  });

  it('does not start when running >= ceiling', async () => {
    let spawned = 0;
    const handle = startQueueLoop({
      log: () => {},
      loadConfig: async () => ({ enabled: true, maxConcurrent: 1, maxWorking: 0, idleGraceMs: 15_000 }),
      countRunning: async () => 5,
      spawnWorker: async () => {
        spawned += 1;
        return 123;
      },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 30));
    await handle.stop();
    expect(spawned).toBe(0);
  });
});

function entry(p: Partial<WorkingSlotEntry>): WorkingSlotEntry {
  return { key: 'k', agentState: null, sinceUpdateMs: null, sinceCreateMs: null, ...p };
}

const GRACE = 15_000;

describe('occupiesWorkingSlot', () => {
  it('counts working and compacting agents', () => {
    expect(occupiesWorkingSlot(entry({ agentState: 'working' }), GRACE)).toBe(true);
    expect(occupiesWorkingSlot(entry({ agentState: 'compacting' }), GRACE)).toBe(true);
  });

  it('frees an errored agent immediately', () => {
    expect(occupiesWorkingSlot(entry({ agentState: 'error', sinceUpdateMs: 0 }), GRACE)).toBe(false);
  });

  it('holds a booting box (no snapshot / unknown) within the startup grace, frees after', () => {
    expect(occupiesWorkingSlot(entry({ agentState: null, sinceCreateMs: 1_000 }), GRACE)).toBe(true);
    expect(occupiesWorkingSlot(entry({ agentState: 'unknown', sinceCreateMs: 1_000 }), GRACE)).toBe(
      true,
    );
    expect(
      occupiesWorkingSlot(entry({ agentState: null, sinceCreateMs: STARTUP_GRACE_MS + 1 }), GRACE),
    ).toBe(false);
    expect(
      occupiesWorkingSlot(
        entry({ agentState: 'unknown', sinceCreateMs: STARTUP_GRACE_MS + 1 }),
        GRACE,
      ),
    ).toBe(false);
  });

  it('debounces non-working states within idleGraceMs, frees past it', () => {
    for (const s of ['idle', 'waiting', 'end-plan', 'question'] as const) {
      expect(occupiesWorkingSlot(entry({ agentState: s, sinceUpdateMs: GRACE - 1 }), GRACE)).toBe(
        true,
      );
      expect(occupiesWorkingSlot(entry({ agentState: s, sinceUpdateMs: GRACE }), GRACE)).toBe(false);
    }
  });

  it('does not hold a non-working agent with no updatedAt', () => {
    expect(occupiesWorkingSlot(entry({ agentState: 'idle', sinceUpdateMs: null }), GRACE)).toBe(
      false,
    );
  });
});

describe('countWorkingSlots', () => {
  it('sums occupied entries', () => {
    const entries: WorkingSlotEntry[] = [
      entry({ agentState: 'working' }),
      entry({ agentState: 'compacting' }),
      entry({ agentState: 'idle', sinceUpdateMs: 1_000 }), // within grace
      entry({ agentState: 'idle', sinceUpdateMs: GRACE + 1 }), // past grace
      entry({ agentState: 'error', sinceUpdateMs: 0 }),
    ];
    expect(countWorkingSlots(entries, GRACE)).toBe(3);
  });
});

describe('selectNextRunnableByWorking', () => {
  it('returns null on an empty list', () => {
    expect(selectNextRunnableByWorking([], 0, 3)).toBeNull();
  });

  it('picks the oldest queued job when working is below the global ceiling', () => {
    const jobs = [
      job({ id: 'a', createdAt: '2024-01-01T00:00:01.000Z' }),
      job({ id: 'b', createdAt: '2024-01-01T00:00:00.000Z' }),
    ].sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
    expect(selectNextRunnableByWorking(jobs, 0, 3)?.id).toBe('b');
  });

  it('honors a per-job maxWorking override above the global', () => {
    const jobs = [job({ id: 'override', maxWorking: 3 })];
    // 2 working, global ceiling 1 — without the override it would skip; with 3 it starts.
    expect(selectNextRunnableByWorking(jobs, 2, 1)?.id).toBe('override');
  });

  it('skips a tight job and picks a later one with headroom', () => {
    const jobs = [
      job({ id: 'small', maxWorking: 1, createdAt: '2024-01-01T00:00:00.000Z' }),
      job({ id: 'big', maxWorking: 5, createdAt: '2024-01-01T00:00:01.000Z' }),
    ];
    expect(selectNextRunnableByWorking(jobs, 2, 1)?.id).toBe('big');
  });

  it('returns null when at the ceiling', () => {
    expect(selectNextRunnableByWorking([job({ id: 'x' })], 3, 3)).toBeNull();
  });
});

describe('defaultCountWorkingBoxes', () => {
  const emptyStatus = { get: () => undefined } as unknown as BoxStatusStore;
  function statusFor(map: Record<string, unknown>): BoxStatusStore {
    return { get: (id: string) => map[id] } as unknown as BoxStatusStore;
  }
  function reg(boxId: string): BoxRegistry {
    const r = new BoxRegistry();
    r.register({
      boxId,
      token: 't',
      name: boxId,
      registeredAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    return r;
  }

  it('counts a registered box whose agent is working', async () => {
    const baseline = await defaultCountWorkingBoxes(new BoxRegistry(), emptyStatus, GRACE);
    const status = statusFor({
      wb: { schema: 1, boxId: 'wb', claude: { state: 'working', updatedAt: new Date().toISOString() } },
    });
    const count = await defaultCountWorkingBoxes(reg('wb'), status, GRACE);
    expect(count - baseline).toBe(1);
  });

  it('counts an in-flight running job whose box has not registered yet', async () => {
    const prefix = `qvitest-inflight-${String(process.pid)}-`;
    const id = `${prefix}1`;
    const baseline = await defaultCountWorkingBoxes(new BoxRegistry(), emptyStatus, GRACE);
    try {
      await writeJob(job({ id, status: 'running', startedAt: new Date().toISOString() }));
      const count = await defaultCountWorkingBoxes(new BoxRegistry(), emptyStatus, GRACE);
      expect(count - baseline).toBe(1);
    } finally {
      const { QUEUE_DIR } = await import('../src/queue.js');
      await rm(join(QUEUE_DIR, `${id}.json`), { force: true });
    }
  });

  it('does not double-count a running job once its box is registered', async () => {
    const prefix = `qvitest-dedup-${String(process.pid)}-`;
    const id = `${prefix}1`;
    const status = statusFor({
      jb: { schema: 1, boxId: 'jb', claude: { state: 'working', updatedAt: new Date().toISOString() } },
    });
    const { QUEUE_DIR } = await import('../src/queue.js');
    try {
      // boxId 'jb' IS registered → the job is counted via its box entry, not the in-flight term.
      await writeJob(job({ id, status: 'running', startedAt: new Date().toISOString(), boxId: 'jb' }));
      const joined = await defaultCountWorkingBoxes(reg('jb'), status, GRACE);
      // Same job but its box is NOT registered → now the in-flight term adds 1 on top.
      await writeJob(
        job({ id, status: 'running', startedAt: new Date().toISOString(), boxId: 'unreg' }),
      );
      const unjoined = await defaultCountWorkingBoxes(reg('jb'), status, GRACE);
      expect(unjoined - joined).toBe(1);
    } finally {
      await rm(join(QUEUE_DIR, `${id}.json`), { force: true });
    }
  });
});

describe('countInFlightCreateJobs', () => {
  // A pid that's essentially never alive — process.kill(pid, 0) → ESRCH.
  const DEAD_PID = 2_147_483_646;

  it('counts a running job whose box is not yet accounted for', () => {
    // No boxId yet (worker hasn't created the box) → in-flight, occupies a slot.
    const jobs = [job({ id: 'a', status: 'running', startedAt: '2024-01-01T00:00:01.000Z' })];
    expect(countInFlightCreateJobs(jobs, new Set())).toBe(1);
  });

  it('does not count a running job once its box id is accounted for', () => {
    // boxId present AND in the accounted set → counted via its box, not here.
    const jobs = [job({ id: 'a', status: 'running', boxId: 'box1' })];
    expect(countInFlightCreateJobs(jobs, new Set(['box1']))).toBe(0);
    // Same job, box NOT in the set → still in-flight, counted.
    expect(countInFlightCreateJobs(jobs, new Set(['other']))).toBe(1);
  });

  it('ignores non-running jobs', () => {
    const jobs = [
      job({ id: 'q', status: 'queued' }),
      job({ id: 'd', status: 'done' }),
      job({ id: 'f', status: 'failed' }),
    ];
    expect(countInFlightCreateJobs(jobs, new Set())).toBe(0);
  });

  it('skips a running job whose worker pid is dead', () => {
    const jobs = [job({ id: 'a', status: 'running', pid: DEAD_PID })];
    expect(countInFlightCreateJobs(jobs, new Set())).toBe(0);
  });

  it('sums multiple in-flight jobs', () => {
    const jobs = [
      job({ id: 'a', status: 'running' }),
      job({ id: 'b', status: 'running', boxId: 'reg', pid: undefined }),
      job({ id: 'c', status: 'running' }),
    ];
    // 'b' is deduped via its box; 'a' and 'c' are in-flight.
    expect(countInFlightCreateJobs(jobs, new Set(['reg']))).toBe(2);
  });
});

describe('prepare (image-bake) lane', () => {
  const DEAD_PID = 2_147_483_646;

  it('selectNextRunnable skips prepare jobs (they have their own lane)', () => {
    const jobs = [job({ id: 'p', kind: 'prepare' }), job({ id: 'c', kind: 'create' })];
    // Even with a free box slot, only the create job is selected here.
    expect(selectNextRunnable(jobs, 0)?.id).toBe('c');
    // A queue of only prepare jobs yields nothing on the box gate.
    expect(selectNextRunnable([job({ id: 'p', kind: 'prepare' })], 0)).toBeNull();
  });

  it('selectNextRunnablePrepare picks the oldest queued prepare under the ceiling', () => {
    const jobs = [
      job({ id: 'a', kind: 'prepare', createdAt: '2024-01-01T00:00:00.000Z' }),
      job({ id: 'b', kind: 'prepare', createdAt: '2024-01-01T00:00:01.000Z' }),
      job({ id: 'c', kind: 'create' }),
    ];
    expect(selectNextRunnablePrepare(jobs, 0)?.id).toBe('a');
    // At the ceiling → nothing starts.
    expect(selectNextRunnablePrepare(jobs, PREPARE_MAX_CONCURRENT)).toBeNull();
  });

  it('countRunningPrepareJobs counts live prepare workers only', () => {
    const jobs = [
      job({ id: 'run', kind: 'prepare', status: 'running' }),
      job({ id: 'dead', kind: 'prepare', status: 'running', pid: DEAD_PID }),
      job({ id: 'queued', kind: 'prepare', status: 'queued' }),
      job({ id: 'createRun', kind: 'create', status: 'running' }),
    ];
    expect(countRunningPrepareJobs(jobs)).toBe(1);
  });

  it('countInFlightCreateJobs ignores prepare jobs (a bake is not a box)', () => {
    const jobs = [
      job({ id: 'bake', kind: 'prepare', status: 'running' }),
      job({ id: 'create', kind: 'create', status: 'running' }),
    ];
    expect(countInFlightCreateJobs(jobs, new Set())).toBe(1);
  });
});

describe('startQueueLoop working-agent gate', () => {
  const cfg = (over: Partial<QueueConfig>): QueueConfig => ({
    enabled: true,
    maxConcurrent: 5,
    maxWorking: 0,
    idleGraceMs: 15_000,
    ...over,
  });

  // Positive assertions poll instead of sleeping a fixed 40ms — on a loaded
  // CI runner the 10ms loop's first tick can land after the window (flaked
  // repeatedly on GitHub Actions). Negative assertions keep the short sleep.
  const waitFor = async (cond: () => boolean, timeoutMs = 2000): Promise<void> => {
    const start = Date.now();
    while (!cond() && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('does not start a job when the working count is at the ceiling', async () => {
    const prefix = `qvitest-wgate-ceil-${String(process.pid)}-`;
    const id = `${prefix}1`;
    const spawned: string[] = [];
    const { QUEUE_DIR } = await import('../src/queue.js');
    try {
      await writeJob(job({ id, createdAt: '2000-01-01T00:00:00.000Z' }));
      const handle = startQueueLoop({
        log: () => {},
        loadConfig: async () => cfg({ maxWorking: 2 }),
        countWorking: async () => 9999,
        spawnWorker: async (j) => {
          spawned.push(j.id);
          return 123;
        },
        intervalMs: 10,
      });
      await new Promise((r) => setTimeout(r, 40));
      await handle.stop();
      expect(spawned).not.toContain(id);
    } finally {
      await rm(join(QUEUE_DIR, `${id}.json`), { force: true });
    }
  });

  it('starts a job when below the working ceiling', async () => {
    const prefix = `qvitest-wgate-go-${String(process.pid)}-`;
    const id = `${prefix}1`;
    const spawned: string[] = [];
    let started = 0;
    const { QUEUE_DIR } = await import('../src/queue.js');
    try {
      await writeJob(job({ id, createdAt: '2000-01-01T00:00:00.000Z' }));
      const handle = startQueueLoop({
        log: () => {},
        loadConfig: async () => cfg({ maxWorking: 1 }),
        // Self-limiting: once one is started the gate is full, so at most 1 spawns.
        countWorking: async () => started,
        spawnWorker: async (j) => {
          started += 1;
          spawned.push(j.id);
          return 123;
        },
        intervalMs: 10,
      });
      await waitFor(() => spawned.includes(id));
      await handle.stop();
      expect(spawned).toContain(id);
    } finally {
      await rm(join(QUEUE_DIR, `${id}.json`), { force: true });
    }
  });

  it('falls back to the running-box gate when maxWorking is 0', async () => {
    const prefix = `qvitest-wgate-fallback-${String(process.pid)}-`;
    const id = `${prefix}1`;
    let runningCalled = false;
    let workingCalled = false;
    const { QUEUE_DIR } = await import('../src/queue.js');
    try {
      await writeJob(job({ id, maxConcurrent: 1, createdAt: '2000-01-01T00:00:00.000Z' }));
      const handle = startQueueLoop({
        log: () => {},
        loadConfig: async () => cfg({ maxWorking: 0 }),
        countRunning: async () => {
          runningCalled = true;
          return 9999;
        },
        countWorking: async () => {
          workingCalled = true;
          return 0;
        },
        spawnWorker: async () => 123,
        intervalMs: 10,
      });
      await waitFor(() => runningCalled);
      await handle.stop();
      expect(runningCalled).toBe(true);
      expect(workingCalled).toBe(false);
    } finally {
      await rm(join(QUEUE_DIR, `${id}.json`), { force: true });
    }
  });

  it('warns and uses the running gate when maxWorking is set but deps are missing', async () => {
    const prefix = `qvitest-wgate-nodeps-${String(process.pid)}-`;
    const id = `${prefix}1`;
    const logs: string[] = [];
    let runningCalled = false;
    const { QUEUE_DIR } = await import('../src/queue.js');
    try {
      await writeJob(job({ id, maxConcurrent: 1, createdAt: '2000-01-01T00:00:00.000Z' }));
      const handle = startQueueLoop({
        log: (l) => logs.push(l),
        loadConfig: async () => cfg({ maxWorking: 2 }),
        countRunning: async () => {
          runningCalled = true;
          return 9999;
        },
        spawnWorker: async () => 123,
        intervalMs: 10,
      });
      await waitFor(() => runningCalled);
      await handle.stop();
      expect(runningCalled).toBe(true);
      expect(logs.some((l) => l.includes('registry/statusStore not wired'))).toBe(true);
    } finally {
      await rm(join(QUEUE_DIR, `${id}.json`), { force: true });
    }
  });
});

describe('loadQueue / writeJob round trip', () => {
  // QUEUE_DIR is captured at module load from $HOME → ~/.agentbox/queue. We
  // write/cleanup with a unique prefix so a user's real queue isn't disturbed.
  it('returns jobs sorted by createdAt ascending, ignoring malformed files', async () => {
    const { QUEUE_DIR } = await import('../src/queue.js');
    const prefix = `queue-vitest-${String(process.pid)}-`;
    const ids = [`${prefix}a`, `${prefix}b`, `${prefix}c`];
    const malformed = `${prefix}malformed`;
    try {
      await writeJob(job({ id: ids[0]!, createdAt: '2024-06-01T00:00:00.000Z' }));
      await writeJob(job({ id: ids[1]!, createdAt: '2024-05-01T00:00:00.000Z' }));
      await writeJob(job({ id: ids[2]!, createdAt: '2024-07-01T00:00:00.000Z' }));
      await writeFile(join(QUEUE_DIR, `${malformed}.json`), '{ not json', 'utf8');

      const jobs = await loadQueue();
      const ours = jobs.filter((j) => j.id.startsWith(prefix));
      expect(ours.map((j) => j.id)).toEqual([ids[1], ids[0], ids[2]]);
      expect(ours.find((j) => j.id === malformed)).toBeUndefined();

      const raw = await readFile(join(QUEUE_DIR, `${ids[0]!}.json`), 'utf8');
      expect((JSON.parse(raw) as QueueJob).agent).toBe('claude-code');
    } finally {
      for (const id of [...ids, malformed]) {
        await rm(join(QUEUE_DIR, `${id}.json`), { force: true });
      }
    }
  });

  it('persists noAgent on the manifest so the worker can skip the agent session', async () => {
    const { QUEUE_DIR } = await import('../src/queue.js');
    const id = `queue-vitest-${String(process.pid)}-noagent`;
    try {
      await writeJob(job({ id, noAgent: true }));
      const raw = JSON.parse(await readFile(join(QUEUE_DIR, `${id}.json`), 'utf8')) as QueueJob;
      expect(raw.noAgent).toBe(true);
      const loaded = (await loadQueue()).find((j) => j.id === id);
      expect(loaded?.noAgent).toBe(true);
    } finally {
      await rm(join(QUEUE_DIR, `${id}.json`), { force: true });
    }
  });
});

describe('orphan reaping (worker died mid-flight)', () => {
  // A worker that dies after being spawned used to leave its manifest `running`
  // forever: the reaper only ran at startup. No terminal status meant no SSE
  // `end`, so a UI progress card sat there advancing against a job that was
  // never coming back. Reaping per-tick is what makes the failure visible.
  it('flips a running job whose pid is dead to failed', async () => {
    const { QUEUE_DIR } = await import('../src/queue.js');
    const id = `queue-vitest-${String(process.pid)}-dead`;
    const changed: QueueJob[] = [];
    try {
      // 999999 is above the OS pid ceiling, so it can never be alive.
      await writeJob(job({ id, status: 'running', pid: 999999 }));
      const handle = startQueueLoop({
        log: () => {},
        loadConfig: async () => ({
          enabled: true,
          maxConcurrent: 1,
          maxWorking: 0,
          idleGraceMs: 15_000,
        }),
        countRunning: async () => 0,
        spawnWorker: async () => 123,
        onStatusChange: (j) => changed.push(j),
        intervalMs: 10,
      });
      await new Promise((r) => setTimeout(r, 80));
      await handle.stop();

      const reaped = (await loadQueue()).find((j) => j.id === id);
      expect(reaped?.status).toBe('failed');
      expect(reaped?.reason).toBe('worker-died');
      // The UI only learns about it through this callback.
      expect(changed.some((j) => j.id === id && j.status === 'failed')).toBe(true);
    } finally {
      await rm(join(QUEUE_DIR, `${id}.json`), { force: true });
    }
  });

  // The spawn window: between marking a job `running` and recording its pid it
  // has no pid. Reaping those on a tick would kill jobs as they start.
  it('leaves a running job with no pid alone on a tick', async () => {
    const { QUEUE_DIR } = await import('../src/queue.js');
    const id = `queue-vitest-${String(process.pid)}-nopid`;
    try {
      const handle = startQueueLoop({
        log: () => {},
        loadConfig: async () => ({
          enabled: true,
          maxConcurrent: 1,
          maxWorking: 0,
          idleGraceMs: 15_000,
        }),
        countRunning: async () => 0,
        spawnWorker: async () => 123,
        intervalMs: 10,
      });
      // Written AFTER the loop's startup pass, so only the per-tick reaper sees it.
      await new Promise((r) => setTimeout(r, 30));
      await writeJob(job({ id, status: 'running' }));
      await new Promise((r) => setTimeout(r, 80));
      await handle.stop();

      const still = (await loadQueue()).find((j) => j.id === id);
      expect(still?.status).toBe('running');
    } finally {
      await rm(join(QUEUE_DIR, `${id}.json`), { force: true });
    }
  });
});
