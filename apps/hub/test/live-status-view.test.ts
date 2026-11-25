// The hub web's live-status helpers mirror @agentbox/core's (the client bundle
// cannot import core); this holds the copy to the same outputs, and covers the
// box-row agent pick.
import * as core from '@agentbox/core';
import { describe, expect, it } from 'vitest';
import * as hub from '../lib/live-status-view';

const counts = [0, 950, 999.6, 1000, 12_345, 99_960, 123_456, 999_600, 1_234_567, 1_234_567_890];
const usages: hub.AgentLiveUsageView[] = [
  { input: 1200, output: 3400, cacheRead: 1_000_000, cacheWrite: 20_000 },
  {
    input: 5,
    output: 7,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 3,
    contextTokens: 90_000,
    contextWindow: 200_000,
    costUsd: 0.42,
  },
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextTokens: 9_000,
    contextWindow: 200_000,
  },
];
const states = ['working', 'waiting', 'question', 'idle', 'error', 'unknown', undefined];

describe('hub live-status view mirrors core', () => {
  it('formatTokenCount', () => {
    for (const n of counts) expect(hub.formatTokenCount(n)).toBe(core.formatTokenCount(n));
  });
  it('usage helpers', () => {
    for (const u of [...usages, undefined]) {
      expect(hub.usageSummary(u)).toEqual(core.usageSummary(u));
      expect(hub.usageBreakdown(u)).toEqual(core.usageBreakdown(u));
      expect(hub.contextFillPct(u)).toEqual(core.contextFillPct(u));
      expect(hub.formatCostUsd(u)).toEqual(core.formatCostUsd(u));
    }
  });
  it('liveActivity: the working-on line only while working, waiting or question', () => {
    for (const state of states) {
      const e = { state, activity: 'bash: npm test' };
      expect(hub.liveActivity(e)).toEqual(core.liveActivity(e));
    }
    expect(hub.liveActivity({ state: 'idle', activity: 'Final reply' })).toBeUndefined();
    expect(hub.liveActivity({ state: 'working', activity: 'Edit server.js' })).toBe(
      'Edit server.js',
    );
  });
});

describe('primaryLive', () => {
  it("prefers the box's own agent", () => {
    const r = hub.primaryLive({
      agent: 'codex',
      agentStatus: {
        claude: { state: 'idle', sessionTitle: 'a' },
        codex: { state: 'working', activity: 'x' },
      },
    });
    expect(r?.agent).toBe('codex');
  });
  it('falls back to a reporting agent with data, else nothing', () => {
    expect(
      hub.primaryLive({
        agent: 'claude',
        agentStatus: { pi: { state: 'unknown' }, opencode: { state: 'idle', sessionTitle: 't' } },
      })?.agent,
    ).toBe('opencode');
    expect(hub.primaryLive({ agent: 'claude', agentStatus: undefined })).toBeUndefined();
    expect(
      hub.primaryLive({ agent: 'claude', agentStatus: { pi: { state: 'unknown' } } }),
    ).toBeUndefined();
  });
  it("falls through when the box's own agent has no data", () => {
    expect(
      hub.primaryLive({
        agent: 'claude',
        agentStatus: { claude: { state: 'unknown' }, codex: { state: 'working', activity: 'x' } },
      })?.agent,
    ).toBe('codex');
  });
});

describe('boxRunning', () => {
  it('reads the raw state: an agent error does not stop the box', () => {
    expect(hub.boxRunning({ state: 'running', status: 'error' })).toBe(true);
    expect(hub.boxRunning({ state: 'paused', status: 'paused' })).toBe(false);
    expect(hub.boxRunning({ status: 'running' })).toBe(true);
    expect(hub.boxRunning({ status: 'error' })).toBe(false);
  });
});
