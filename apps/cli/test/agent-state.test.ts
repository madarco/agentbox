import { describe, expect, it } from 'vitest';
import type { BoxStatusClaude, ClaudePlanPayload, ClaudeQuestionPayload } from '@agentbox/ctl';
import {
  AGENT_WAIT_STATES,
  derivedAgentState,
  isAgentWaitState,
  isInputNeeded,
  isPromptReady,
  matchesAgentWaitState,
} from '../src/lib/wait/agent-state.js';

const PLAN: ClaudePlanPayload = { plan: '## test plan', capturedAt: '2026-05-27T00:00:00.000Z' };
const QUESTION: ClaudeQuestionPayload = {
  questions: [
    { question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }] },
  ],
  capturedAt: '2026-05-27T00:00:00.000Z',
};

function claude(overrides: Partial<BoxStatusClaude> = {}): BoxStatusClaude {
  return {
    state: 'idle',
    updatedAt: null,
    sessionRunning: true,
    ...overrides,
  };
}

describe('isAgentWaitState', () => {
  it('accepts the documented union', () => {
    for (const s of AGENT_WAIT_STATES) expect(isAgentWaitState(s)).toBe(true);
  });
  it('rejects unknown values', () => {
    expect(isAgentWaitState('unknown')).toBe(false);
    expect(isAgentWaitState('')).toBe(false);
    expect(isAgentWaitState('done')).toBe(false);
  });
});

describe('isPromptReady', () => {
  it('is true when idle, session running, no pending plan/question', () => {
    expect(isPromptReady(claude())).toBe(true);
  });
  it('is false when not idle', () => {
    expect(isPromptReady(claude({ state: 'working' }))).toBe(false);
    expect(isPromptReady(claude({ state: 'end-plan' }))).toBe(false);
  });
  it('is false when tmux session is down (idle but disconnected)', () => {
    expect(isPromptReady(claude({ sessionRunning: false }))).toBe(false);
  });
  it('is false when a plan is still pending (race window)', () => {
    expect(isPromptReady(claude({ plan: PLAN }))).toBe(false);
  });
  it('is false when a question is still pending', () => {
    expect(isPromptReady(claude({ question: QUESTION }))).toBe(false);
  });
});

describe('matchesAgentWaitState', () => {
  it('passes through raw states', () => {
    expect(matchesAgentWaitState(claude({ state: 'working' }), 'working')).toBe(true);
    expect(matchesAgentWaitState(claude({ state: 'end-plan', plan: PLAN }), 'end-plan')).toBe(true);
    expect(matchesAgentWaitState(claude({ state: 'question', question: QUESTION }), 'question')).toBe(true);
  });

  it("uses prompt-ready semantics for 'prompt'", () => {
    expect(matchesAgentWaitState(claude(), 'prompt')).toBe(true);
    expect(matchesAgentWaitState(claude({ state: 'idle', plan: PLAN }), 'prompt')).toBe(false);
    expect(matchesAgentWaitState(claude({ sessionRunning: false }), 'prompt')).toBe(false);
  });

  it("does not let 'idle' match 'prompt' or vice versa directly", () => {
    // idle is a state; prompt is a derived condition. A claude in idle WITH a
    // pending question is still matchable as 'idle' but NOT 'prompt'.
    const c = claude({ state: 'idle', question: QUESTION });
    expect(matchesAgentWaitState(c, 'idle')).toBe(true);
    expect(matchesAgentWaitState(c, 'prompt')).toBe(false);
  });

  it("treats 'end-plan' as 'plan payload present' so the question→waiting flicker is invisible", () => {
    // Common in practice: PreToolUse:ExitPlanMode sets end-plan with the plan
    // payload, then Notification:permission_prompt overwrites state to
    // 'waiting'. Wait-for end-plan should still match.
    expect(matchesAgentWaitState(claude({ state: 'waiting', plan: PLAN }), 'end-plan')).toBe(true);
    expect(matchesAgentWaitState(claude({ state: 'waiting' }), 'end-plan')).toBe(false);
  });

  it("treats 'question' the same way", () => {
    expect(matchesAgentWaitState(claude({ state: 'waiting', question: QUESTION }), 'question')).toBe(true);
    expect(matchesAgentWaitState(claude({ state: 'waiting' }), 'question')).toBe(false);
  });
});

describe('derivedAgentState', () => {
  it("renders 'prompt' when prompt-ready", () => {
    expect(derivedAgentState(claude())).toBe('prompt');
  });
  it('renders the semantic label when a payload is pending, even on a waiting flicker', () => {
    expect(derivedAgentState(claude({ state: 'waiting', plan: PLAN }))).toBe('end-plan');
    expect(derivedAgentState(claude({ state: 'waiting', question: QUESTION }))).toBe('question');
  });
  it('renders the raw state otherwise', () => {
    expect(derivedAgentState(claude({ state: 'working' }))).toBe('working');
    expect(derivedAgentState(claude({ state: 'waiting' }))).toBe('waiting');
  });
});

describe('isInputNeeded / wait-for input-needed', () => {
  it("includes 'input-needed' in the waitable union", () => {
    expect(isAgentWaitState('input-needed')).toBe(true);
  });

  it('matches every state where the agent wants a human', () => {
    // Blocked mid-turn.
    expect(isInputNeeded(claude({ state: 'waiting' }))).toBe(true);
    expect(isInputNeeded(claude({ state: 'end-plan', plan: PLAN }))).toBe(true);
    expect(isInputNeeded(claude({ state: 'question', question: QUESTION }))).toBe(true);
    // Sticky-payload race: plan/question survive a 'waiting' flicker.
    expect(isInputNeeded(claude({ state: 'waiting', plan: PLAN }))).toBe(true);
    expect(isInputNeeded(claude({ state: 'waiting', question: QUESTION }))).toBe(true);
    // Turn finished — prompt ready for the next message.
    expect(isInputNeeded(claude())).toBe(true);
    // Errored.
    expect(isInputNeeded(claude({ state: 'error' }))).toBe(true);
  });

  it('does NOT match while the agent is still busy', () => {
    expect(isInputNeeded(claude({ state: 'working' }))).toBe(false);
    expect(isInputNeeded(claude({ state: 'compacting' }))).toBe(false);
  });

  it('does NOT match a busy state even when a stale plan/question payload lingers', () => {
    expect(isInputNeeded(claude({ state: 'working', plan: PLAN }))).toBe(false);
    expect(isInputNeeded(claude({ state: 'working', question: QUESTION }))).toBe(false);
    expect(isInputNeeded(claude({ state: 'compacting', plan: PLAN }))).toBe(false);
  });

  it('does NOT match idle when the session is down (nothing to give input to)', () => {
    expect(isInputNeeded(claude({ state: 'idle', sessionRunning: false }))).toBe(false);
  });

  it('is reachable through matchesAgentWaitState', () => {
    expect(matchesAgentWaitState(claude({ state: 'question', question: QUESTION }), 'input-needed')).toBe(true);
    expect(matchesAgentWaitState(claude({ state: 'working' }), 'input-needed')).toBe(false);
  });
});

describe('matchesAgentWaitState — compacting / error', () => {
  it("passes through 'compacting' and 'error' as raw state matches", () => {
    expect(matchesAgentWaitState(claude({ state: 'compacting' }), 'compacting')).toBe(true);
    expect(matchesAgentWaitState(claude({ state: 'error' }), 'error')).toBe(true);
  });

  it('does not let a stale plan/question payload silently match compacting/error', () => {
    // The plan/question sticky-payload trick is specific to end-plan/question.
    // compacting/error don't carry payload, so the raw state must match.
    expect(matchesAgentWaitState(claude({ state: 'working', plan: PLAN }), 'compacting')).toBe(false);
    expect(matchesAgentWaitState(claude({ state: 'working' }), 'error')).toBe(false);
  });
});
