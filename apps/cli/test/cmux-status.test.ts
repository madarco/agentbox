import { describe, expect, it } from 'vitest';
import {
  cmuxStatusActive,
  isAttentionState,
  mapActivityToWorkspace,
} from '../src/terminal/cmux-status.js';

describe('mapActivityToWorkspace', () => {
  it('maps working/compacting to a blue "working" workspace', () => {
    expect(mapActivityToWorkspace('claude', 'working')).toEqual({
      description: 'claude · working',
      color: 'Blue',
    });
    expect(mapActivityToWorkspace('codex', 'compacting')).toEqual({
      description: 'codex · working',
      color: 'Blue',
    });
  });

  it('maps question/waiting/end-plan to an amber "needs input"/"plan ready"', () => {
    expect(mapActivityToWorkspace('claude', 'question')).toEqual({
      description: 'claude · needs input',
      color: 'Amber',
    });
    expect(mapActivityToWorkspace('claude', 'waiting')?.color).toBe('Amber');
    expect(mapActivityToWorkspace('claude', 'end-plan')).toEqual({
      description: 'claude · plan ready',
      color: 'Amber',
    });
  });

  it('maps error to red and idle to a cleared tint', () => {
    expect(mapActivityToWorkspace('claude', 'error')).toEqual({
      description: 'claude · error',
      color: 'Red',
    });
    expect(mapActivityToWorkspace('claude', 'idle')).toEqual({
      description: 'claude · idle',
      color: '',
    });
  });

  it('uses the agent name as the label per mode', () => {
    expect(mapActivityToWorkspace('opencode', 'working')?.description).toBe('opencode · working');
  });

  it('returns null (leave as-is) for unknown/absent state and for shell', () => {
    expect(mapActivityToWorkspace('claude', 'unknown')).toBeNull();
    expect(mapActivityToWorkspace('claude', undefined)).toBeNull();
    expect(mapActivityToWorkspace('shell', 'working')).toBeNull();
  });
});

describe('isAttentionState', () => {
  it('is true for states where the agent is blocked on the user', () => {
    for (const s of ['question', 'waiting', 'end-plan', 'error'] as const) {
      expect(isAttentionState(s)).toBe(true);
    }
  });

  it('is false for working/idle/compacting/unknown/absent', () => {
    for (const s of ['working', 'idle', 'compacting', 'unknown'] as const) {
      expect(isAttentionState(s)).toBe(false);
    }
    expect(isAttentionState(undefined)).toBe(false);
  });
});

describe('cmuxStatusActive', () => {
  it('is true only when CMUX_SOCKET_PATH is a non-empty string', () => {
    expect(cmuxStatusActive({ CMUX_SOCKET_PATH: '/tmp/cmux.sock' })).toBe(true);
    expect(cmuxStatusActive({ CMUX_SOCKET_PATH: '' })).toBe(false);
    expect(cmuxStatusActive({})).toBe(false);
  });

  it('does not depend on TMUX (works even when tmux is nested in cmux)', () => {
    expect(
      cmuxStatusActive({ TMUX: '/tmp/tmux-0/default,1,0', CMUX_SOCKET_PATH: '/tmp/cmux.sock' }),
    ).toBe(true);
  });
});
