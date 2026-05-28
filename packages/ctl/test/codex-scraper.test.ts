import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { matchState, startCodexScraper } from '../src/codex-scraper.js';
import type { AgentActivityState } from '../src/types.js';

describe('matchState (codex pane patterns)', () => {
  it('matches the trust-hook dialog as waiting', () => {
    expect(matchState('Hooks need review\n3 hooks are new')).toBe('waiting');
  });

  it('matches y/n approval prompts as waiting', () => {
    expect(matchState('Allow this command? Press y/n')).toBe('waiting');
    expect(matchState('Approve this tool? [Y/n]')).toBe('waiting');
    expect(matchState('Waiting for your response')).toBe('waiting');
  });

  it("matches '/compact' progress as compacting", () => {
    expect(matchState('Compacting conversation…')).toBe('compacting');
    expect(matchState('Summarizing the conversation to free context')).toBe('compacting');
  });

  it('matches error frames', () => {
    expect(matchState('Error: failed to parse')).toBe('error');
    expect(matchState('Traceback (most recent call last):')).toBe('error');
    expect(matchState('Failed: unreachable')).toBe('error');
  });

  it('matches active-work signals (codex-specific TUI fragments)', () => {
    expect(matchState('Thinking...')).toBe('working');
    expect(matchState('● Worked for 2s')).toBe('working');
    expect(matchState('Streaming response')).toBe('working');
    expect(matchState('tool call shell')).toBe('working');
    expect(matchState('Running command in sandbox')).toBe('working');
    expect(matchState('Editing apps/cli/src/foo.ts')).toBe('working');
  });

  it('does NOT match generic english that contains the word "working"', () => {
    // The directory-trust prompt's warning text has "Working with untrusted
    // contents" but that does not mean codex is in a working state.
    expect(matchState('Do you trust the contents of this directory? Working with untrusted contents comes with risk.')).toBe(
      'waiting',
    );
    // Random unrelated paragraph mentioning "working" — should fall through
    // to idle if the codex footer is present, else null.
    expect(matchState('Some doc text about working with codex.')).toBe(null);
  });

  it("matches codex's input-prompt footer as idle", () => {
    // The model · cwd status line at the bottom of codex's TUI when ready
    // for input. Lower priority than working/waiting so it doesn't override
    // an in-flight turn that still shows the footer.
    expect(matchState('gpt-5.5 high · /workspace')).toBe('idle');
    expect(matchState('OpenAI Codex (v0.134.0)')).toBe('idle');
  });

  it('returns null on totally unmatched panes (preserve last-known state)', () => {
    expect(matchState('')).toBe(null);
    expect(matchState('random unrelated text\n> _')).toBe(null);
  });

  it("priority order: 'waiting' wins over 'working' on a frame that has both", () => {
    // E.g. codex shows the approval dialog while a streaming-response trace
    // remains visible above. `waiting` is the load-bearing state for callers.
    const pane = 'Streaming response\n\nAllow this command? Press y/n';
    expect(matchState(pane)).toBe('waiting');
  });
});

describe('startCodexScraper', () => {
  const calls: { state: AgentActivityState; payload?: unknown }[] = [];
  const reporter = {
    setCodexState: (state: AgentActivityState, payload?: unknown): void => {
      calls.push({ state, payload });
    },
  } as unknown as Parameters<typeof startCodexScraper>[0]['reporter'];

  beforeEach(() => {
    calls.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('pushes the baseline idle when a session appears, then pushes only on transitions', async () => {
    let i = 0;
    const panes: (string | null)[] = [
      '',                              // tick 0: empty pane → no pattern, baseline idle
      'Thinking...',                   // tick 1: working
      'Streaming response',            // tick 2: same state (working) — no push
      'Allow this command? Press y/n', // tick 3: waiting (transition)
    ];
    const handle = startCodexScraper({
      reporter,
      sessionName: 'codex',
      intervalMs: 1000,
      capturePane: async () => panes[Math.min(i++, panes.length - 1)] ?? null,
    });

    // Wait for the immediate first probe to land.
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(1000); // tick 1
    await vi.advanceTimersByTimeAsync(1000); // tick 2 — no push
    await vi.advanceTimersByTimeAsync(1000); // tick 3

    handle.stop();
    expect(calls.map((c) => c.state)).toEqual(['idle', 'working', 'waiting']);
  });

  it('does not push when no codex session is present (capture returns null)', async () => {
    const handle = startCodexScraper({
      reporter,
      sessionName: 'codex',
      intervalMs: 1000,
      capturePane: async () => null,
    });
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(2000);
    handle.stop();
    expect(calls).toEqual([]);
  });

  it('re-emits idle baseline when a session disappears and reappears', async () => {
    let i = 0;
    const panes: (string | null)[] = [
      'Thinking...',         // session up: baseline → idle, then working in same tick
      null,                  // session disappears
      null,
      '',                    // session back: baseline idle again
    ];
    const handle = startCodexScraper({
      reporter,
      sessionName: 'codex',
      intervalMs: 1000,
      capturePane: async () => panes[Math.min(i++, panes.length - 1)] ?? null,
    });
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(3000);
    handle.stop();

    // Allowed: [idle, working] then [idle] again on reappearance.
    expect(calls.map((c) => c.state)).toEqual(['idle', 'working', 'idle']);
  });
});
