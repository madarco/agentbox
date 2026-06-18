import { describe, expect, it } from 'vitest';
import { herdrStatusActive, mapActivityToAgentState } from '../src/terminal/herdr-status.js';

describe('mapActivityToAgentState', () => {
  it('maps working/compacting to a working state', () => {
    expect(mapActivityToAgentState('claude', 'working')).toEqual({
      state: 'working',
      message: 'claude · working',
    });
    expect(mapActivityToAgentState('codex', 'compacting')).toEqual({
      state: 'working',
      message: 'codex · working',
    });
  });

  it('maps question/waiting/end-plan/error to blocked (Herdr handles needs-input)', () => {
    expect(mapActivityToAgentState('claude', 'question')).toEqual({
      state: 'blocked',
      message: 'claude · needs input',
    });
    expect(mapActivityToAgentState('claude', 'waiting')?.state).toBe('blocked');
    expect(mapActivityToAgentState('claude', 'end-plan')).toEqual({
      state: 'blocked',
      message: 'claude · plan ready',
    });
    expect(mapActivityToAgentState('claude', 'error')).toEqual({
      state: 'blocked',
      message: 'claude · error',
    });
  });

  it('maps idle to an idle state', () => {
    expect(mapActivityToAgentState('claude', 'idle')).toEqual({
      state: 'idle',
      message: 'claude · idle',
    });
  });

  it('uses the agent name as the label per mode', () => {
    expect(mapActivityToAgentState('opencode', 'working')?.message).toBe('opencode · working');
  });

  it('returns null (leave as-is) for unknown/absent state and for shell', () => {
    expect(mapActivityToAgentState('claude', 'unknown')).toBeNull();
    expect(mapActivityToAgentState('claude', undefined)).toBeNull();
    expect(mapActivityToAgentState('shell', 'working')).toBeNull();
  });
});

describe('herdrStatusActive', () => {
  const live = {
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/herdr.sock',
    HERDR_PANE_ID: 'w1:p1',
  };

  it('is true only with HERDR_ENV=1 and a non-empty socket path and pane id', () => {
    expect(herdrStatusActive(live)).toBe(true);
    expect(herdrStatusActive({ ...live, HERDR_SOCKET_PATH: '' })).toBe(false);
    expect(herdrStatusActive({ ...live, HERDR_PANE_ID: '' })).toBe(false);
    expect(herdrStatusActive({ ...live, HERDR_ENV: '0' })).toBe(false);
    expect(herdrStatusActive({})).toBe(false);
  });

  it('does not depend on TMUX (works even when tmux is nested in Herdr)', () => {
    expect(herdrStatusActive({ ...live, TMUX: '/tmp/tmux-0/default,1,0' })).toBe(true);
  });
});
