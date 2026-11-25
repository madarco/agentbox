import type { AgentPlanLimits } from '@agentbox/core';
import { describe, expect, it, vi } from 'vitest';
import {
  FIRST_READ_WAIT_MS,
  LIMITS_REFRESH_MS,
  STALE_AFTER_MS,
  transcriptLimitsView,
  createLimitsSource,
  freshLimits,
  type AccountLimits,
  windowLabel,
} from '../lib/backend/account-limits';
import { boxesOnSubscription } from '../lib/backend/accounts';

const WINDOWS = [
  { id: 'weekly_all', label: 'Weekly, all models', pct: 64, windowMinutes: 10080 },
  { id: 'weekly_scoped:Fable', label: 'Weekly, Fable', pct: 31, windowMinutes: 10080 },
];

describe('codex limits', () => {
  it('labels windows by length and keeps a reached limit', () => {
    expect(windowLabel(300, 'p')).toBe('5-hour');
    expect(windowLabel(10080, 'p')).toBe('Weekly');
    expect(windowLabel(4320, 'p')).toBe('3-day');
    expect(windowLabel(undefined, 'primary')).toBe('primary');
    const l = transcriptLimitsView({
      windows: [{ id: 'primary', pct: 6, windowMinutes: 10080, resetsAt: '2026-11-28T00:00:00Z' }],
      plan: 'pro',
      ts: '2026-11-25T10:00:00Z',
      updatedAt: 1,
    });
    expect(l).toEqual({
      windows: [
        {
          id: 'primary',
          label: 'Weekly',
          pct: 6,
          resetsAt: '2026-11-28T00:00:00Z',
          windowMinutes: 10080,
        },
      ],
      atLimit: false,
      updatedAt: '2026-11-25T10:00:00Z',
      source: 'transcript',
    });
    expect(
      transcriptLimitsView({
        windows: [{ id: 'primary', pct: 40 }],
        reached: 'primary',
        ts: null,
        updatedAt: 0,
      }).atLimit,
    ).toBe(true);
  });
});

describe('createLimitsSource', () => {
  const secret = JSON.stringify({
    claudeAiOauth: { accessToken: 'at', expiresAt: Date.now() + 3_600_000 },
  });
  const setup = () => {
    let t = Date.now();
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    // A reader shaped like claude's: one call through the source's fetch.
    const reader: AgentPlanLimits = {
      async read(sec, ctx) {
        if (!sec) return null;
        const res = await ctx.fetch('https://usage.example/', { signal: ctx.signal });
        return res.ok ? WINDOWS : null;
      },
    };
    const src = createLimitsSource({
      readSecret: async () => secret,
      readerOf: (agent) => (agent === 'claude' ? reader : undefined),
      transcriptLimits: async (sub) =>
        sub === 'codex/default'
          ? { windows: [{ id: 'primary', pct: 100, windowMinutes: 300 }], ts: null, updatedAt: t }
          : null,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => t,
    });
    return { src, fetch, advance: (ms: number) => (t += ms) };
  };

  it('calls the usage endpoint only while a box runs, at most every refresh interval', async () => {
    const { src, fetch, advance } = setup();
    expect(await src.limitsFor('claude', 'default', false)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    const l = await src.limitsFor('claude', 'default', true);
    expect(l?.windows.map((w) => w.label)).toEqual(['Weekly, all models', 'Weekly, Fable']);
    expect(fetch).toHaveBeenCalledTimes(1);
    await src.limitsFor('claude', 'default', true);
    expect(fetch).toHaveBeenCalledTimes(1);
    // The last value stays when no box runs.
    expect(await src.limitsFor('claude', 'default', false)).toEqual(l);
    advance(LIMITS_REFRESH_MS);
    await src.limitsFor('claude', 'default', true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a refusal is no data, not 0%; a later success fills it', async () => {
    const { src, fetch, advance } = setup();
    fetch.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    expect(await src.limitsFor('claude', 'ci', true)).toBeUndefined();
    advance(LIMITS_REFRESH_MS);
    expect((await src.limitsFor('claude', 'ci', true))?.atLimit).toBe(false);
  });

  it('a slow endpoint never holds the listing; its answer lands for the next read', async () => {
    vi.useFakeTimers();
    try {
      const { src, fetch } = setup();
      let answer!: (r: Response) => void;
      fetch.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
      const first = src.limitsFor('claude', 'slow', true);
      await vi.advanceTimersByTimeAsync(FIRST_READ_WAIT_MS);
      expect(await first).toBeUndefined();
      answer(new Response('{}', { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
      expect((await src.limitsFor('claude', 'slow', false))?.windows).toHaveLength(2);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed read keeps the last values, which turn stale', async () => {
    const { src, fetch, advance } = setup();
    expect(await src.limitsFor('claude', 'x', true)).toBeDefined();
    fetch.mockResolvedValue(new Response('{}', { status: 401 }));
    advance(LIMITS_REFRESH_MS);
    expect((await src.limitsFor('claude', 'x', true))?.stale).toBeUndefined();
    advance(LIMITS_REFRESH_MS + 1000);
    expect((await src.limitsFor('claude', 'x', true))?.stale).toBe(true);
  });

  it('a read in flight when the account is forgotten is dropped on arrival', async () => {
    vi.useFakeTimers();
    try {
      const { src, fetch } = setup();
      let answer!: (r: Response) => void;
      fetch.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
      const first = src.limitsFor('claude', 'gone', true);
      await vi.advanceTimersByTimeAsync(FIRST_READ_WAIT_MS);
      await first;
      src.forget('claude', 'gone');
      answer(new Response('{}', { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(await src.limitsFor('claude', 'gone', false)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forget drops a removed account, so a new one under the id starts empty', async () => {
    const { src } = setup();
    expect(await src.limitsFor('claude', 'work', true)).toBeDefined();
    src.forget('claude', 'work');
    expect(await src.limitsFor('claude', 'work', false)).toBeUndefined();
  });

  it('codex reads the transcript, with no network call', async () => {
    const { src, fetch } = setup();
    expect(await src.limitsFor('codex', 'default', false)).toMatchObject({
      atLimit: true,
      windows: [{ label: '5-hour', pct: 100 }],
    });
    expect(await src.limitsFor('codex', 'team', true)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('boxesOnSubscription', () => {
  const boxes = [
    { name: 'a', agents: ['claude'] },
    { name: 'b', agents: ['claude'], accounts: { claude: 'work' } },
    { name: 'c', agents: ['opencode'], borrowedCredentials: ['codex'] },
    { name: 'd', accounts: { claude: 'work' } },
    { name: 'e' },
  ];
  it('counts default boxes, named ones, and a borrower under its lender', () => {
    expect(boxesOnSubscription(boxes, 'claude', 'default').map((b) => b.name)).toEqual(['a']);
    // opencode runs on a borrowed codex login.
    expect(boxesOnSubscription(boxes, 'codex', 'default').map((b) => b.name)).toEqual(['c']);
    expect(boxesOnSubscription(boxes, 'claude', 'work').map((b) => b.name)).toEqual(['b', 'd']);
    expect(boxesOnSubscription(boxes, 'opencode', 'default')).toEqual([]);
  });
});

describe('freshLimits', () => {
  const l = (resets: string[]): AccountLimits => ({
    windows: resets.map((r, i) => ({ id: String(i), label: String(i), pct: 100, resetsAt: r })),
    atLimit: true,
    updatedAt: '2026-11-25T08:00:00Z',
    source: 'transcript',
  });
  const now = Date.parse('2026-11-25T10:00:00Z');

  it('drops windows that have reset, and the at-limit that came with them', () => {
    expect(freshLimits(l(['2026-11-25T09:00:00Z']), now)).toBeUndefined();
    const mixed = freshLimits(l(['2026-11-25T09:00:00Z', '2026-11-28T09:00:00Z']), now);
    expect(mixed?.windows.map((w) => w.id)).toEqual(['1']);
    expect(mixed?.atLimit).toBe(true);
    const current = l(['2026-11-28T09:00:00Z']);
    expect(freshLimits(current, now)).toMatchObject({ windows: current.windows, atLimit: true });
    expect(freshLimits(undefined, now)).toBeUndefined();
  });

  it('ages out windows with no reset time by their length, or a day with no length', () => {
    const at = (windows: AccountLimits['windows'], updatedAt: string): AccountLimits => ({
      windows,
      atLimit: false,
      updatedAt,
      source: 'usage-api',
    });
    const fiveHour = { id: 'a', label: '5-hour', pct: 40, windowMinutes: 300 };
    const untimed = { id: 'b', label: 'b', pct: 40 };
    expect(freshLimits(at([fiveHour], '2026-11-25T06:00:00Z'), now)?.windows).toHaveLength(1);
    expect(freshLimits(at([fiveHour], '2026-11-25T04:00:00Z'), now)).toBeUndefined();
    expect(freshLimits(at([untimed], '2026-11-24T11:00:00Z'), now)?.windows).toHaveLength(1);
    expect(freshLimits(at([untimed], '2026-11-24T09:00:00Z'), now)).toBeUndefined();
  });

  it('marks values stale after two missed refreshes, not before', () => {
    const w = [{ id: 'a', label: 'Weekly', pct: 40, windowMinutes: 10080 }];
    const read = (ago: number): AccountLimits => ({
      windows: w,
      atLimit: false,
      updatedAt: new Date(now - ago).toISOString(),
      source: 'usage-api',
    });
    expect(freshLimits(read(STALE_AFTER_MS - 1000), now)?.stale).toBeUndefined();
    expect(freshLimits(read(STALE_AFTER_MS + 1000), now)?.stale).toBe(true);
  });
});
