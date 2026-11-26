import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageContribution } from '@agentbox/usage-view';
import {
  ContributionLimitError,
  ContributionStore,
  createContributionPusher,
  FULL_DAYS,
  PERIODIC_DAYS,
} from '../lib/backend/usage-contrib';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 21, 6);
const at = (day: number, h: number): number => Date.UTC(2026, 10, day, h);

const contrib = (o: Partial<UsageContribution> = {}): UsageContribution => ({
  v: 1,
  machineId: 'pc-1',
  window: { since: '2026-11-19', until: '2026-11-21' },
  tz: 'UTC',
  intervals: [],
  tokens: [],
  shipped: [],
  boxes: [],
  boxRuns: [],
  ...o,
});

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'usage-contrib-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ContributionStore', () => {
  it("replaces the pushed window and keeps the rest of that machine's year", async () => {
    const store = new ContributionStore(tmp(), () => NOW);
    await store.upsert(
      contrib({
        window: { since: '2026-11-01', until: '2026-11-21' },
        intervals: [
          { boxId: 'b1', agent: 'claude', provider: 'docker', start: at(2, 9), end: at(2, 10) },
          { boxId: 'b1', agent: 'claude', provider: 'docker', start: at(20, 9), end: at(20, 10) },
        ],
        tokens: [
          { day: '2026-11-02', agent: 'claude', provider: 'docker', boxId: 'b1', tokens: 5 },
          { day: '2026-11-20', agent: 'claude', provider: 'docker', boxId: 'b1', tokens: 7 },
        ],
        boxes: [{ boxId: 'b1', agent: 'claude', provider: 'docker' }],
      }),
    );
    // The later short push covers 19-21 Nov: the 20 Nov rows are replaced.
    await store.upsert(
      contrib({
        intervals: [
          { boxId: 'b1', agent: 'claude', provider: 'docker', start: at(20, 9), end: at(20, 11) },
        ],
        tokens: [
          { day: '2026-11-20', agent: 'claude', provider: 'docker', boxId: 'b1', tokens: 9 },
        ],
        boxes: [{ boxId: 'b1', agent: 'claude', provider: 'docker' }],
      }),
    );
    const [c] = await store.list();
    expect(c!.intervals.map((i) => (i.end - i.start) / HOUR)).toEqual([1, 2]);
    expect(c!.tokens.map((t) => t.tokens)).toEqual([5, 9]);
    expect(c!.window).toEqual({ since: '2026-11-01', until: '2026-11-21' });
    const [info] = await store.info();
    expect(info).toMatchObject({ machineId: 'pc-1', intervals: 2, tokenRows: 2, boxes: 1 });
  });

  it('caps the number of machines and writes only <id>.json files', async () => {
    const dir = tmp();
    const store = new ContributionStore(dir, () => NOW);
    for (let i = 0; i < 64; i++) await store.upsert(contrib({ machineId: `m${String(i)}` }));
    await expect(store.upsert(contrib({ machineId: 'one-too-many' }))).rejects.toBeInstanceOf(
      ContributionLimitError,
    );
    // A machine already there can still push.
    await store.upsert(contrib({ machineId: 'm3' }));
    expect(readdirSync(dir).every((n) => /^m\d+\.json$/.test(n))).toBe(true);
  });
});

describe('createContributionPusher', () => {
  function harness(o: { enabled?: boolean; target?: boolean; status?: number } = {}) {
    const posts: { url: string; auth: string; body: UsageContribution }[] = [];
    const builds: number[] = [];
    let intervals = 0;
    let zone = 'UTC';
    const pusher = createContributionPusher({
      enabled: async () => o.enabled ?? true,
      target: async () => (o.target === false ? null : { url: 'https://cb.example', apiKey: 'k' }),
      machineId: () => 'pc-1',
      build: async ({ days }) => {
        builds.push(days);
        return contrib({
          window: { since: days === FULL_DAYS ? '2025-11-21' : '2026-10-18', until: '2026-11-21' },
          intervals: Array.from({ length: intervals }, (_, i) => ({
            boxId: 'b1',
            agent: 'claude' as const,
            provider: 'docker' as const,
            start: at(20, i),
            end: at(20, i) + 60_000,
          })),
        });
      },
      fetch: (async (url: string, init: RequestInit) => {
        posts.push({
          url,
          auth: (init.headers as Record<string, string>).Authorization!,
          body: JSON.parse(init.body as string) as UsageContribution,
        });
        return new Response('{}', { status: o.status ?? 200 });
      }) as typeof fetch,
      now: () => NOW,
      tz: () => zone,
    });
    return {
      pusher,
      posts,
      builds,
      setIntervals: (n: number) => (intervals = n),
      setZone: (z: string) => (zone = z),
    };
  }

  it('sends the year first, then the recent weeks only when they changed', async () => {
    const h = harness();
    expect((await h.pusher.tick()).status).toBe('pushed');
    expect((await h.pusher.tick()).status).toBe('pushed');
    expect((await h.pusher.tick()).status).toBe('unchanged');
    h.setIntervals(1);
    expect((await h.pusher.tick()).status).toBe('pushed');
    expect(h.builds).toEqual([FULL_DAYS, PERIODIC_DAYS, PERIODIC_DAYS, PERIODIC_DAYS]);
    expect(h.posts[0]!.url).toBe('https://cb.example/api/v1/usage/contributions');
    expect(h.posts[0]!.auth).toBe('Bearer k');
    // On demand: like a tick, or the year with `full`.
    expect((await h.pusher.syncNow()).status).toBe('unchanged');
    expect((await h.pusher.syncNow({ full: true })).status).toBe('pushed');
    expect(h.builds.at(-1)).toBe(FULL_DAYS);
  });

  it('sends the year again after a zone change', async () => {
    const h = harness();
    await h.pusher.tick();
    await h.pusher.tick();
    h.setZone('Europe/Rome');
    await h.pusher.tick();
    expect(h.builds).toEqual([FULL_DAYS, PERIODIC_DAYS, FULL_DAYS]);
  });

  it('does nothing when turned off or with no remote hub, and reports a refused push', async () => {
    expect((await harness({ enabled: false }).pusher.tick()).status).toBe('disabled');
    expect((await harness({ target: false }).pusher.syncNow()).status).toBe('no-remote');
    const refused = harness({ status: 413 });
    const r = await refused.pusher.syncNow({ full: true });
    expect(r).toMatchObject({ status: 'failed', error: expect.stringContaining('413') });
    // A failed push is retried on the next tick (it was never recorded as sent).
    expect((await refused.pusher.tick()).status).toBe('failed');
    expect(refused.builds).toEqual([FULL_DAYS, FULL_DAYS]);
  });
});
