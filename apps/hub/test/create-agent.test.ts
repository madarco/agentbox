import { describe, expect, it } from 'vitest';
import { createStartsSession, resolveCreateAgentSpec } from '../lib/boxes/create-agent';

/**
 * The control-plane (repo-clone) create path's agent resolution.
 *
 * It used to narrow to four hardcoded ids and return `undefined` for anything
 * else, so a create for `openclaw` — or any `agentbox agent add` plugin agent —
 * built a box that registered with NO agent and started nothing. The job
 * reported success. These assert the two halves of the fix: the registry is the
 * accept-list, and unknown fails loudly.
 */
describe('resolveCreateAgentSpec', () => {
  it('resolves by canonical id', () => {
    expect(resolveCreateAgentSpec('codex')?.id).toBe('codex');
  });

  it('resolves the wire alias', () => {
    expect(resolveCreateAgentSpec('claude-code')?.id).toBe('claude');
  });

  it('resolves an agent outside the four built-ins', () => {
    expect(resolveCreateAgentSpec('openclaw')?.id).toBe('openclaw');
  });

  it('has no agent for "none" or an absent one', () => {
    expect(resolveCreateAgentSpec('none')).toBeUndefined();
    expect(resolveCreateAgentSpec(undefined)).toBeUndefined();
  });

  it('throws rather than silently building an agent-less box', () => {
    expect(() => resolveCreateAgentSpec('gemini')).toThrow(/no agent sync spec/);
  });
});

describe('createStartsSession', () => {
  it('is false for a service agent — ctl runs its daemon, there is no tmux', () => {
    expect(createStartsSession(resolveCreateAgentSpec('openclaw'))).toBe(false);
  });

  it('is true for a TUI agent', () => {
    expect(createStartsSession(resolveCreateAgentSpec('claude-code'))).toBe(true);
  });

  it('is false when there is no agent', () => {
    expect(createStartsSession(undefined)).toBe(false);
  });
});
