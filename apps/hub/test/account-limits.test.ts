import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_USAGE_URL,
  LIMITS_REFRESH_MS,
  claudeUsageToken,
  claudeUsageWindows,
  codexLimits,
  createLimitsSource,
  windowLabel,
} from '../lib/backend/account-limits';
import { boxesOnSubscription } from '../lib/backend/accounts';

// The shape measured 2026-11-25 on a Max 20x login (values made up).
const MAX_20X = {
  five_hour: null,
  seven_day: { utilization: 64.0, resets_at: '2026-11-30T09:00:00Z' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 64,
      severity: 'normal',
      resets_at: '2026-11-30T09:00:00Z',
      scope: null,
      is_active: true,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 31,
      severity: 'normal',
      resets_at: '2026-11-30T09:00:00Z',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
};

describe('claudeUsageWindows', () => {
  it('reads limits[]: one window each, a scoped one named by its model', () => {
    expect(claudeUsageWindows(MAX_20X)).toEqual([
      {
        id: 'weekly_all',
        label: 'Weekly, all models',
        pct: 64,
        resetsAt: '2026-11-30T09:00:00Z',
        windowMinutes: 10080,
      },
      {
        id: 'weekly_scoped:Fable',
        label: 'Weekly, Fable',
        pct: 31,
        resetsAt: '2026-11-30T09:00:00Z',
        windowMinutes: 10080,
      },
    ]);
  });

  it('a lone window carries no "all models"; a session group is the 5-hour one', () => {
    expect(
      claudeUsageWindows({
        limits: [
          { kind: 'session', group: 'session', percent: 12, resets_at: 'x' },
          { kind: 'weekly_all', group: 'weekly', percent: 3, scope: null },
        ],
      })!.map((w) => w.label),
    ).toEqual(['5-hour', 'Weekly']);
  });

  it('falls back to the fixed fields, skipping null windows', () => {
    const { limits: _drop, ...fixed } = MAX_20X;
    expect(claudeUsageWindows(fixed)).toEqual([
      {
        id: 'seven_day',
        label: 'Weekly',
        pct: 64,
        windowMinutes: 10080,
        resetsAt: '2026-11-30T09:00:00Z',
      },
    ]);
  });

  it('null for a body of neither shape', () => {
    expect(claudeUsageWindows({ error: 'x' })).toBeNull();
    expect(claudeUsageWindows('nope')).toBeNull();
  });
});

describe('claudeUsageToken', () => {
  const now = 1_000_000_000_000;
  const login = (expiresAt: number) =>
    JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt } });
  it("a login's access token while it is valid, never an expired one", () => {
    expect(claudeUsageToken(login(now + 3_600_000), now)).toBe('at');
    expect(claudeUsageToken(login(now + 30_000), now)).toBeNull();
  });
  it('a setup token as is; an API key, garbage or nothing: null', () => {
    expect(claudeUsageToken(JSON.stringify({ kind: 'setup-token', token: 'st' }), now)).toBe('st');
    expect(claudeUsageToken(JSON.stringify({ kind: 'api-key', token: 'k' }), now)).toBeNull();
    expect(claudeUsageToken('not json', now)).toBeNull();
    expect(claudeUsageToken(null, now)).toBeNull();
  });
});

describe('codex limits', () => {
  it('labels windows by length and keeps a reached limit', () => {
    expect(windowLabel(300, 'p')).toBe('5-hour');
    expect(windowLabel(10080, 'p')).toBe('Weekly');
    expect(windowLabel(4320, 'p')).toBe('3-day');
    expect(windowLabel(undefined, 'primary')).toBe('primary');
    const l = codexLimits({
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
      codexLimits({
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
    const fetch = vi.fn(async () => new Response(JSON.stringify(MAX_20X), { status: 200 }));
    const src = createLimitsSource({
      readSecret: async () => secret,
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
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLAUDE_USAGE_URL);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer at');
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
