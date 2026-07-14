import { afterAll, describe, expect, it, vi } from 'vitest';
import { startRetentionLoop } from '../src/retention.js';
import { SqliteStore } from '../src/store/sqlite-store.js';
import type { CreateJobRow, PromptRow } from '../src/store/store.js';

const open: SqliteStore[] = [];
function store(): SqliteStore {
  const s = new SqliteStore({ path: ':memory:' });
  open.push(s);
  return s;
}
afterAll(async () => {
  await Promise.all(open.map((s) => s.close()));
});

function prompt(id: string, over: Partial<PromptRow>): PromptRow {
  return {
    id,
    boxId: 'b1',
    ev: { id, kind: 'confirm', message: 'push?', context: { command: 'git push' } },
    method: 'git.lease-token',
    params: {},
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...over,
  };
}
function job(id: string, over: Partial<CreateJobRow>): CreateJobRow {
  return {
    id,
    status: 'queued',
    request: { repoUrl: 'https://example.com/r.git', provider: 'e2b' },
    createdAt: new Date().toISOString(),
    ...over,
  };
}

const OLD = '2000-01-01T00:00:00.000Z';
const CUTOFF = '2020-01-01T00:00:00.000Z';

describe('SqliteStore.prunePrompts', () => {
  it('removes answered + expired rows older than the cutoff, keeps live ones', async () => {
    const s = store();
    await s.createPrompt(prompt('answered-old', { status: 'answered', createdAt: OLD }));
    await s.createPrompt(prompt('answered-new', { status: 'answered' })); // now
    await s.createPrompt(prompt('expired-old', { expiresAt: OLD })); // pending but long expired
    await s.createPrompt(prompt('pending-live', {})); // pending, no expiry

    expect(await s.prunePrompts(CUTOFF)).toBe(2);
    expect(await s.getPrompt('answered-old')).toBeNull();
    expect(await s.getPrompt('expired-old')).toBeNull();
    expect((await s.getPrompt('answered-new'))?.id).toBe('answered-new');
    expect((await s.getPrompt('pending-live'))?.id).toBe('pending-live');
  });
});

describe('SqliteStore.pruneCreateJobs', () => {
  it('removes finished jobs older than the cutoff, keeps running/queued', async () => {
    const s = store();
    await s.enqueueCreateJob(job('done-old', { status: 'done', finishedAt: OLD }));
    await s.enqueueCreateJob(job('failed-old', { status: 'failed', finishedAt: OLD }));
    await s.enqueueCreateJob(job('done-new', { status: 'done', finishedAt: new Date().toISOString() }));
    await s.enqueueCreateJob(job('queued', {}));

    expect(await s.pruneCreateJobs(CUTOFF)).toBe(2);
    expect(await s.getCreateJob('done-old')).toBeNull();
    expect(await s.getCreateJob('failed-old')).toBeNull();
    expect((await s.getCreateJob('done-new'))?.id).toBe('done-new');
    expect((await s.getCreateJob('queued'))?.id).toBe('queued');
  });
});

describe('startRetentionLoop', () => {
  it('is a no-op when the store has no prune methods', async () => {
    const bare = {} as unknown as Parameters<typeof startRetentionLoop>[0]['store'];
    const handle = startRetentionLoop({ store: bare, log: () => {} });
    await handle.stop(); // must not throw
  });

  it('sweeps on tick using now - retentionMs as the cutoff', async () => {
    const s = store();
    await s.createPrompt(prompt('old', { status: 'answered', createdAt: OLD }));
    await s.enqueueCreateJob(job('old', { status: 'done', finishedAt: OLD }));
    const lines: string[] = [];
    const handle = startRetentionLoop({
      store: s,
      log: (l) => lines.push(l),
      intervalMs: 5,
      retentionMs: 1000,
      now: () => Date.parse('2020-06-01T00:00:00.000Z'),
    });
    await vi.waitFor(() => expect(lines.some((l) => l.includes('pruned'))).toBe(true));
    await handle.stop();
    expect(await s.getPrompt('old')).toBeNull();
    expect(await s.getCreateJob('old')).toBeNull();
  });
});
