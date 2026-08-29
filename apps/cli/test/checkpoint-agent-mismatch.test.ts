import { describe, expect, it } from 'vitest';
import { agentSetMismatch, describeAgentMismatch } from '../src/checkpoint-lookup.js';

describe('agentSetMismatch', () => {
  it('is silent when the manifest records no agent set', () => {
    // THE regression this file exists for. Every checkpoint captured before the
    // field existed lacks it, as does any box predating per-agent selection.
    // Treating absent as a mismatch would warn on every restore of every
    // pre-existing checkpoint — noise on a path that used to be quiet.
    expect(agentSetMismatch(undefined, ['codex'])).toBeUndefined();
    expect(agentSetMismatch([], ['codex'])).toBeUndefined();
  });

  it('is silent when the new box has no agent set', () => {
    // A bare `agentbox create` is agentless, which means "all" — not a conflict
    // with a checkpoint that happens to carry one.
    expect(agentSetMismatch(['claude'], undefined)).toBeUndefined();
    expect(agentSetMismatch(['claude'], [])).toBeUndefined();
  });

  it('reports a genuine mismatch', () => {
    expect(agentSetMismatch(['claude'], ['codex'])).toEqual({
      captured: ['claude'],
      requested: ['codex'],
    });
  });

  it('is order-insensitive', () => {
    // The set is normalised the same way variant lookup keys are, so a
    // differently-ordered but identical set is NOT a mismatch.
    expect(agentSetMismatch(['codex', 'claude'], ['claude', 'codex'])).toBeUndefined();
  });

  it('treats a differing set size as a mismatch', () => {
    expect(agentSetMismatch(['claude'], ['claude', 'codex'])).not.toBeUndefined();
  });

  it('names both sides and says what will happen', () => {
    const msg = describeAgentMismatch({ captured: ['claude'], requested: ['codex'] });
    expect(msg).toContain('claude');
    expect(msg).toContain('codex');
    // The user needs to know it still boots — this is advisory, not a failure.
    expect(msg).toMatch(/installed on top|baked in/);
  });
});
