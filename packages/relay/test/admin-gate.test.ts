import { describe, expect, it } from 'vitest';
import { adminGateAllows } from '../src/admin-gate.js';

describe('adminGateAllows', () => {
  it('always allows loopback callers (laptop CLI/tray, unchanged)', () => {
    expect(adminGateAllows(true, undefined, '')).toBe(true);
    expect(adminGateAllows(true, 'anything', 'tok')).toBe(true);
  });

  it('rejects non-loopback when no admin token is configured (laptop relay)', () => {
    expect(adminGateAllows(false, undefined, '')).toBe(false);
    expect(adminGateAllows(false, 'guess', '')).toBe(false);
  });

  it('allows non-loopback only with the matching admin bearer (control box)', () => {
    expect(adminGateAllows(false, 'secret-token', 'secret-token')).toBe(true);
    expect(adminGateAllows(false, 'wrong', 'secret-token')).toBe(false);
    expect(adminGateAllows(false, undefined, 'secret-token')).toBe(false);
    expect(adminGateAllows(false, '', 'secret-token')).toBe(false);
  });

  it('is not prefix-tolerant', () => {
    expect(adminGateAllows(false, 'secret-token-longer', 'secret-token')).toBe(false);
    expect(adminGateAllows(false, 'secret-toke', 'secret-token')).toBe(false);
  });
});
