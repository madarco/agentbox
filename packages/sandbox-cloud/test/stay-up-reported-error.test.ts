import { describe, expect, it } from 'vitest';
import { reportedError } from '../src/detached-agent.js';

describe('reportedError (the -i stay-up verdict)', () => {
  const since = Date.parse('2026-11-24T10:00:00Z');
  const status = (state: string, updatedAt: string | null) =>
    JSON.stringify({ services: [], agents: { opencode: { state, updatedAt } } });

  it('fails on an error the agent reported during this launch', () => {
    expect(reportedError(status('error', '2026-11-24T10:00:03Z'), 'opencode', since)).toBe(true);
  });

  it('ignores an error from before the launch', () => {
    expect(reportedError(status('error', '2026-11-24T09:50:00Z'), 'opencode', since)).toBe(false);
  });

  it('ignores other states, other agents, an older ctl and garbage', () => {
    expect(reportedError(status('idle', '2026-11-24T10:00:03Z'), 'opencode', since)).toBe(false);
    expect(reportedError(status('error', '2026-11-24T10:00:03Z'), 'claude', since)).toBe(false);
    expect(reportedError(JSON.stringify({ services: [] }), 'opencode', since)).toBe(false);
    expect(reportedError('', 'opencode', since)).toBe(false);
  });
});
