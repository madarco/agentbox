import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadQueue,
  selectNextRunnable,
  startQueueLoop,
  writeJob,
  type QueueJob,
} from '../src/queue.js';

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
      loadConfig: async () => ({ enabled: false, maxConcurrent: 1 }),
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
      loadConfig: async () => ({ enabled: true, maxConcurrent: 1 }),
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
});
