import { describe, expect, it } from 'vitest';
import { primaryAgent } from '../src/box-record.js';

describe('primaryAgent', () => {
  it('names the agent a box was created for, service agents included', () => {
    expect(primaryAgent({ agents: ['openclaw'] })).toBe('openclaw');
    // `lastAgent` never holds a service agent; `agents` wins over it.
    expect(primaryAgent({ agents: ['openclaw'], lastAgent: 'claude' })).toBe('openclaw');
    expect(primaryAgent({ lastAgent: 'codex' })).toBe('codex');
  });

  it('names nothing for an agentless box', () => {
    expect(primaryAgent({})).toBeUndefined();
    expect(primaryAgent({ agents: [] })).toBeUndefined();
    expect(primaryAgent({ agents: ['none'] })).toBeUndefined();
  });
});
