import { describe, expect, it } from 'vitest';
import {
  gitIdentityFieldProblem,
  parseGitIdentity,
  resolveCreateGitIdentity,
} from '../src/git-identity.js';

describe('gitIdentityFieldProblem', () => {
  it('accepts an ordinary name and email', () => {
    expect(gitIdentityFieldProblem("Marco D'Alia", 'name')).toBeNull();
    expect(gitIdentityFieldProblem('ada@example.com', 'email')).toBeNull();
  });

  it('refuses a newline: the value lands in git config inside the box', () => {
    expect(gitIdentityFieldProblem('Ada\nLovelace', 'name')).toMatch(/newlines/);
    expect(gitIdentityFieldProblem('ada@example.com\r', 'email')).toMatch(/newlines/);
  });

  it('refuses empty, non-string and over-long values', () => {
    expect(gitIdentityFieldProblem('  ', 'name')).toMatch(/empty/);
    expect(gitIdentityFieldProblem(42, 'name')).toMatch(/string/);
    expect(gitIdentityFieldProblem('a'.repeat(257), 'name')).toMatch(/too long/);
  });
});

describe('parseGitIdentity', () => {
  it('needs both halves', () => {
    expect(parseGitIdentity({ name: 'Ada' }).ok).toBe(false);
    expect(parseGitIdentity({ name: 'Ada', email: 'ada@example.com' })).toEqual({
      ok: true,
      value: { name: 'Ada', email: 'ada@example.com' },
    });
  });
});

describe('resolveCreateGitIdentity', () => {
  const pc = { name: 'Ada', email: 'ada@example.com' };
  const hub = { name: 'Team', email: 'team@example.com' };

  it('takes the request over the hub default', () => {
    expect(resolveCreateGitIdentity(pc, hub)).toEqual({ ...pc, source: 'request' });
  });

  it('uses the hub default when the request carries none', () => {
    expect(resolveCreateGitIdentity(undefined, hub)).toEqual({ ...hub, source: 'hub-default' });
  });

  it('leaves the provider to its own fallbacks when neither is set', () => {
    expect(resolveCreateGitIdentity(undefined, undefined)).toBeUndefined();
  });
});
