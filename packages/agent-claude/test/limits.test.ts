import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_USAGE_URL,
  claudePlanLimits,
  claudeUsageToken,
  claudeUsageWindows,
} from '../src/limits.js';

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
  it('two rows of one kind and scope still get distinct ids', () => {
    const w = claudeUsageWindows({
      limits: [
        { kind: 'weekly_all', group: 'weekly', percent: 10 },
        { kind: 'weekly_all', group: 'weekly', percent: 20 },
      ],
    });
    expect(w?.map((x) => x.id)).toEqual(['weekly_all', 'weekly_all#2']);
  });

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

describe('claudePlanLimits', () => {
  const secret = JSON.stringify({
    claudeAiOauth: { accessToken: 'at', expiresAt: Date.now() + 3_600_000 },
  });
  const ctx = (fetch: typeof globalThis.fetch) => ({
    fetch,
    now: Date.now(),
    signal: new AbortController().signal,
  });

  it('calls the usage endpoint with the access token and reads its windows', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(MAX_20X), { status: 200 }));
    const w = await claudePlanLimits.read(secret, ctx(fetch as unknown as typeof globalThis.fetch));
    expect(w?.map((x) => x.label)).toEqual(['Weekly, all models', 'Weekly, Fable']);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLAUDE_USAGE_URL);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer at');
  });

  it('no call without a usable token; a refusal is null', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 403 }));
    const f = fetch as unknown as typeof globalThis.fetch;
    expect(await claudePlanLimits.read(null, ctx(f))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(await claudePlanLimits.read(secret, ctx(f))).toBeNull();
  });
});
