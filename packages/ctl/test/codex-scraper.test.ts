import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { matchState, startCodexScraper, type CodexPaneCapture } from '../src/codex-scraper.js';
import type { AgentActivityState } from '../src/types.js';

describe('matchState (codex title + pane)', () => {
  it('reads a spinner-prefixed title as working', () => {
    expect(matchState('⠋ Fix the login bug | /workspace', '')).toBe('working');
    expect(matchState('◦ workspace | /workspace', '')).toBe('working');
  });

  it('reads Action Required as waiting', () => {
    expect(matchState('[ ! ] Action Required | Fix the bug | /workspace', '')).toBe('waiting');
  });

  it('reads a plain title as idle', () => {
    expect(matchState('Fix the login bug | /workspace', '')).toBe('idle');
    expect(matchState('workspace | /workspace', '')).toBe('idle');
  });

  it("does not read 0.172's turn footer as working (it ends a turn)", () => {
    expect(matchState('Fix the login bug | /workspace', '● Worked for 2m 10s')).toBe('idle');
  });

  it('a blocking dialog in the pane wins over the title', () => {
    expect(matchState('workspace | /workspace', 'Hooks need review\n3 hooks are new')).toBe(
      'waiting',
    );
    expect(
      matchState(
        '⠋ x',
        'Do you trust the contents of this directory? Working with untrusted contents comes with risk.',
      ),
    ).toBe('waiting');
    expect(matchState('', 'Allow this command? Press y/n')).toBe('waiting');
  });

  it('returns null while codex has not set a title (keep the last state)', () => {
    expect(matchState('', '')).toBe(null);
    expect(matchState('   ', 'random text')).toBe(null);
  });
});

describe('startCodexScraper', () => {
  const calls: { agent: string; state: AgentActivityState; payload?: unknown }[] = [];
  const reporter = {
    setAgentState: (agent: string, state: AgentActivityState, payload?: unknown): void => {
      calls.push({ agent, state, payload });
    },
  } as unknown as Parameters<typeof startCodexScraper>[0]['reporter'];
  const f = (title: string, pane = ''): CodexPaneCapture => ({ title, pane });

  beforeEach(() => {
    calls.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('pushes the baseline idle when a session appears, then pushes only on transitions', async () => {
    let i = 0;
    const frames: (CodexPaneCapture | null)[] = [
      f(''), // tick 0: no title yet → baseline idle only
      f('⠋ task | /workspace'), // tick 1: working
      f('⠙ task | /workspace'), // tick 2: same state — no push
      f('[ ! ] Action Required | task | /workspace'), // tick 3: waiting
      f('task | /workspace', '● Worked for 3s'), // tick 4: idle
    ];
    const handle = startCodexScraper({
      reporter,
      sessionName: 'codex',
      intervalMs: 1000,
      capture: async () => frames[Math.min(i++, frames.length - 1)] ?? null,
    });

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(4000);

    handle.stop();
    expect(calls.map((c) => c.state)).toEqual(['idle', 'working', 'waiting', 'idle']);
    expect(new Set(calls.map((c) => c.agent))).toEqual(new Set(['codex']));
  });

  it('does not push when no codex session is present (capture returns null)', async () => {
    const handle = startCodexScraper({
      reporter,
      sessionName: 'codex',
      intervalMs: 1000,
      capture: async () => null,
    });
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(2000);
    handle.stop();
    expect(calls).toEqual([]);
  });

  it('re-emits idle baseline when a session disappears and reappears', async () => {
    let i = 0;
    const frames: (CodexPaneCapture | null)[] = [f('⠋ x | /workspace'), null, null, f('')];
    const handle = startCodexScraper({
      reporter,
      sessionName: 'codex',
      intervalMs: 1000,
      capture: async () => frames[Math.min(i++, frames.length - 1)] ?? null,
    });
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(3000);
    handle.stop();
    expect(calls.map((c) => c.state)).toEqual(['idle', 'working', 'idle']);
  });
});
