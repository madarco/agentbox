import { describe, expect, it } from 'vitest';
import {
  isSyncAgentKind,
  normalizeLastAgent,
  SYNC_AGENT_KINDS,
  toQueueKind,
  toSyncKind,
} from '../src/sync/agent-kind.js';

describe('agent-kind adapter', () => {
  it('toSyncKind maps the wire spelling to canonical', () => {
    expect(toSyncKind('claude-code')).toBe('claude');
    expect(toSyncKind('claude')).toBe('claude');
    expect(toSyncKind('codex')).toBe('codex');
    expect(toSyncKind('opencode')).toBe('opencode');
  });

  it('toSyncKind throws on an unknown kind (no silent wrong-agent seed)', () => {
    expect(() => toSyncKind('gemini')).toThrow(/unknown agent kind/);
  });

  it('toQueueKind maps canonical back to the frozen wire spelling', () => {
    expect(toQueueKind('claude')).toBe('claude-code');
    expect(toQueueKind('codex')).toBe('codex');
    expect(toQueueKind('opencode')).toBe('opencode');
  });

  it('round-trips through the boundary', () => {
    for (const k of SYNC_AGENT_KINDS) {
      expect(toSyncKind(toQueueKind(k))).toBe(k);
    }
  });

  it('normalizeLastAgent is read-time back-compat that never throws', () => {
    expect(normalizeLastAgent('claude-code')).toBe('claude'); // legacy record
    expect(normalizeLastAgent('claude')).toBe('claude');
    expect(normalizeLastAgent('codex')).toBe('codex');
    expect(normalizeLastAgent('opencode')).toBe('opencode');
    expect(normalizeLastAgent(undefined)).toBeUndefined();
    expect(normalizeLastAgent(null)).toBeUndefined();
    expect(normalizeLastAgent('gemini')).toBeUndefined(); // unknown, no throw
  });

  it('isSyncAgentKind guards the canonical set', () => {
    expect(isSyncAgentKind('claude')).toBe(true);
    expect(isSyncAgentKind('claude-code')).toBe(false); // wire spelling is not canonical
    expect(isSyncAgentKind('nope')).toBe(false);
  });
});
