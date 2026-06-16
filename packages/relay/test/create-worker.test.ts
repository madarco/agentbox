import { describe, expect, it } from 'vitest';
import { drainCreateJobs, drainOneCreateJob } from '../src/create-worker.js';
import { handleRelayRequest, type ControlPlaneDeps } from '../src/core/handler.js';
import { MemoryStore } from '../src/store/memory-store.js';
import type { CreateJobRequest } from '../src/store/store.js';

const ADMIN = 'admin';

function deps(store: MemoryStore): ControlPlaneDeps {
  return { store, leaser: null, adminToken: ADMIN };
}
function r(method: string, path: string, init: { bearer?: string; body?: unknown } = {}) {
  return {
    method,
    path,
    query: new URLSearchParams(),
    bearer: init.bearer ?? '',
    bodyText: init.body !== undefined ? JSON.stringify(init.body) : '',
  };
}

describe('box-create flow', () => {
  it('POST /remote/boxes enqueues, GET reports status, worker runs it', async () => {
    const store = new MemoryStore();
    const d = deps(store);

    // Enqueue via the admin API.
    const enq = await handleRelayRequest(
      r('POST', '/remote/boxes', {
        bearer: ADMIN,
        body: { repoUrl: 'https://github.com/acme/widgets.git', provider: 'e2b', name: 'demo' },
      }),
      d,
    );
    expect(enq.status).toBe(202);
    const jobId = (enq.body as { jobId: string }).jobId;

    // Queued until a worker runs.
    const queued = await handleRelayRequest(r('GET', `/remote/boxes/${jobId}`, { bearer: ADMIN }), d);
    expect((queued.body as { status: string }).status).toBe('queued');

    // Worker drains it with a fake create fn.
    const seen: CreateJobRequest[] = [];
    const processed = await drainCreateJobs(
      store,
      (req) => {
        seen.push(req);
        return Promise.resolve({ boxId: 'box-xyz' });
      },
      'worker-1',
    );
    expect(processed).toBe(1);
    expect(seen[0]?.repoUrl).toBe('https://github.com/acme/widgets.git');

    const done = await handleRelayRequest(r('GET', `/remote/boxes/${jobId}`, { bearer: ADMIN }), d);
    expect((done.body as { status: string; result: { boxId: string } }).status).toBe('done');
    expect((done.body as { result: { boxId: string } }).result.boxId).toBe('box-xyz');
  });

  it('requires the admin bearer', async () => {
    const store = new MemoryStore();
    const res = await handleRelayRequest(
      r('POST', '/remote/boxes', { body: { repoUrl: 'x', provider: 'e2b' } }),
      deps(store),
    );
    expect(res.status).toBe(401);
  });

  it('a failing create marks the job failed (worker never throws)', async () => {
    const store = new MemoryStore();
    await store.enqueueCreateJob({
      id: 'j1',
      status: 'queued',
      request: { repoUrl: 'x', provider: 'e2b' },
      createdAt: new Date().toISOString(),
    });
    const id = await drainOneCreateJob(
      store,
      () => Promise.reject(new Error('provider exploded')),
      'w1',
    );
    expect(id).toBe('j1');
    const job = await store.getCreateJob('j1');
    expect(job?.status).toBe('failed');
    expect(job?.result?.error).toMatch(/provider exploded/);
  });

  it('drains nothing when the queue is empty', async () => {
    const store = new MemoryStore();
    expect(await drainOneCreateJob(store, () => Promise.resolve({ boxId: 'x' }), 'w1')).toBeNull();
  });
});
