import { describe, expect, it } from 'vitest';
import { detectAgentFromEnv, resolveForkProvider } from '../src/commands/fork.js';

// Pure env-in/agent-out. No HOME/fs access (apps/cli tests have no HOME
// isolation, so this suite must never touch the filesystem).
describe('detectAgentFromEnv', () => {
  it('detects claude from CLAUDECODE=1', () => {
    expect(detectAgentFromEnv({ CLAUDECODE: '1' })).toBe('claude');
  });

  it('detects claude from CLAUDE_CODE_SESSION_ID', () => {
    expect(detectAgentFromEnv({ CLAUDE_CODE_SESSION_ID: 'abc-123' })).toBe('claude');
  });

  it('detects codex from CODEX_THREAD_ID', () => {
    expect(detectAgentFromEnv({ CODEX_THREAD_ID: '019ef101-684f-72d1-804e-f7ae3bf64aa8' })).toBe(
      'codex',
    );
  });

  it('prefers claude when both agents leak env (nested launch)', () => {
    expect(detectAgentFromEnv({ CLAUDECODE: '1', CODEX_THREAD_ID: 'x' })).toBe('claude');
  });

  it('returns undefined when neither agent env is present', () => {
    expect(detectAgentFromEnv({})).toBeUndefined();
  });

  it('ignores blank/whitespace env values', () => {
    expect(detectAgentFromEnv({ CLAUDE_CODE_SESSION_ID: '  ', CODEX_THREAD_ID: '' })).toBeUndefined();
  });
});

describe('resolveForkProvider', () => {
  it('accepts a positional provider (`agentbox fork hetzner`)', () => {
    expect(resolveForkProvider('hetzner', undefined)).toBe('hetzner');
  });

  it('accepts --provider', () => {
    expect(resolveForkProvider(undefined, 'vercel')).toBe('vercel');
  });

  it('returns undefined when neither is given (default docker downstream)', () => {
    expect(resolveForkProvider(undefined, undefined)).toBeUndefined();
  });

  it('treats a blank --provider as not passed', () => {
    expect(resolveForkProvider(undefined, '  ')).toBeUndefined();
  });

  it('allows positional and flag when they agree', () => {
    expect(resolveForkProvider('docker', 'docker')).toBe('docker');
  });

  it('throws when positional and flag conflict', () => {
    expect(() => resolveForkProvider('hetzner', 'docker')).toThrow(/given twice/);
  });

  it('throws on an unknown provider', () => {
    expect(() => resolveForkProvider('nimbus', undefined)).toThrow(/expected one of/);
  });
});
