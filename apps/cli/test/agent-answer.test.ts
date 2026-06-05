import { describe, expect, it } from 'vitest';
import type { BoxStatusClaude } from '@agentbox/ctl';
import {
  answerKeystrokes,
  inTuiKind,
  isTuiId,
  mintTuiId,
  parseTuiId,
  resolveQuestionOption,
} from '../src/lib/agent-answer.js';

function claude(partial: Partial<BoxStatusClaude>): BoxStatusClaude {
  return {
    state: 'idle',
    updatedAt: '2026-06-05T00:00:00.000Z',
    sessionRunning: true,
    ...partial,
  };
}

const PLAN = { plan: 'Step 1\nStep 2', capturedAt: '2026-06-05T00:00:01.000Z' };
const QUESTION = {
  questions: [
    {
      question: 'Which approach?',
      options: [{ label: 'MVP first' }, { label: 'Risk first' }, { label: 'User first' }],
    },
  ],
  capturedAt: '2026-06-05T00:00:02.000Z',
};

describe('inTuiKind', () => {
  it('classifies plan / question / permission', () => {
    expect(inTuiKind(claude({ state: 'end-plan', plan: PLAN }))).toBe('plan');
    expect(inTuiKind(claude({ state: 'question', question: QUESTION }))).toBe('question');
    expect(inTuiKind(claude({ state: 'waiting' }))).toBe('permission');
  });

  it('returns null when not parked', () => {
    expect(inTuiKind(claude({ state: 'idle' }))).toBeNull();
    expect(inTuiKind(claude({ state: 'prompt' as BoxStatusClaude['state'] }))).toBeNull();
  });

  it('ignores a stale payload while the agent is busy', () => {
    // A plan payload still attached during active work must not surface.
    expect(inTuiKind(claude({ state: 'working', plan: PLAN }))).toBeNull();
    expect(inTuiKind(claude({ state: 'compacting', question: QUESTION }))).toBeNull();
  });
});

describe('mintTuiId / parseTuiId — race-safe ids', () => {
  it('mints a self-describing id and round-trips through parse', () => {
    const minted = mintTuiId('boxA', claude({ state: 'question', question: QUESTION }));
    expect(minted).not.toBeNull();
    expect(minted!.kind).toBe('question');
    const parsed = parseTuiId(minted!.id);
    expect(parsed).toMatchObject({ boxId: 'boxA', kind: 'question' });
    expect(isTuiId(minted!.id)).toBe(true);
  });

  it('is stable for identical content', () => {
    const a = mintTuiId('boxA', claude({ state: 'end-plan', plan: PLAN }));
    const b = mintTuiId('boxA', claude({ state: 'end-plan', plan: PLAN }));
    expect(a!.id).toBe(b!.id);
  });

  it('changes when the prompt content changes (so a stale id is refused)', () => {
    const first = mintTuiId('boxA', claude({ state: 'question', question: QUESTION }));
    const changed = mintTuiId(
      'boxA',
      claude({
        state: 'question',
        question: { ...QUESTION, capturedAt: '2026-06-05T00:09:09.000Z' },
      }),
    );
    expect(first!.id).not.toBe(changed!.id);
  });

  it('differs across boxes and kinds', () => {
    const q = mintTuiId('boxA', claude({ state: 'question', question: QUESTION }))!.id;
    const qOther = mintTuiId('boxB', claude({ state: 'question', question: QUESTION }))!.id;
    expect(q).not.toBe(qOther);
  });

  it('returns null when nothing is pending', () => {
    expect(mintTuiId('boxA', claude({ state: 'idle' }))).toBeNull();
  });

  it('parseTuiId rejects a bare relay UUID', () => {
    expect(isTuiId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(parseTuiId('550e8400-e29b-41d4-a716-446655440000')).toBeNull();
  });
});

describe('answerKeystrokes', () => {
  it('default approve sends Enter', () => {
    expect(answerKeystrokes('claude', 'plan', {})).toEqual([{ type: 'key', value: 'Enter' }]);
  });

  it('deny sends Escape', () => {
    expect(answerKeystrokes('claude', 'question', { deny: true })).toEqual([
      { type: 'key', value: 'Escape' },
    ]);
  });

  it('option N types the digit then Enter (with a settle delay)', () => {
    const steps = answerKeystrokes('claude', 'question', { option: 2 });
    expect(steps[0]).toEqual({ type: 'literal', value: '2' });
    expect(steps[steps.length - 1]).toEqual({ type: 'key', value: 'Enter' });
    expect(steps.some((s) => s.type === 'delay')).toBe(true);
  });
});

describe('resolveQuestionOption', () => {
  const c = claude({ state: 'question', question: QUESTION });

  it('accepts a valid 1-based number', () => {
    expect(resolveQuestionOption(c, '2')).toBe(2);
  });

  it('rejects an out-of-range number', () => {
    expect(resolveQuestionOption(c, '9')).toBeNull();
    expect(resolveQuestionOption(c, '0')).toBeNull();
  });

  it('matches a label case-insensitively (exact then prefix)', () => {
    expect(resolveQuestionOption(c, 'risk first')).toBe(2);
    expect(resolveQuestionOption(c, 'User')).toBe(3);
  });

  it('returns null for an unmatched label', () => {
    expect(resolveQuestionOption(c, 'nope')).toBeNull();
  });
});
