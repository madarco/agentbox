import { describe, expect, it } from 'vitest';
import { rejectionMessage } from '../src/lib/agent-login-run.js';
import {
  CLAUDE_LOGIN_SPEC,
  CODEX_LOGIN_SPEC,
  extractCodexUserCode,
  OPENCODE_LOGIN_SPEC,
} from '../src/lib/agent-login-specs.js';

const ESC = String.fromCharCode(27);

// Verbatim from `codex login --device-auth` under a pty (docs/agent-login-guided-plan.md).
const CODEX_TRANSCRIPT = [
  'Welcome to Codex [v0.144.1]',
  "OpenAI's command-line coding agent",
  '',
  'Follow these steps to sign in with ChatGPT using device code authorization:',
  '',
  '1. Open this link in your browser and sign in to your account',
  '   https://auth.openai.com/codex/device',
  '',
  '2. Enter this one-time code (expires in 15 minutes)',
  '   YQ16-PPHIE',
  '',
].join('\n');

// Verbatim from `opencode auth login -p <provider>` under a pty.
const OPENCODE_API_KEY = ['┌  Add credential', '│', '◆  Enter your API key', '│  _', '└'].join('\n');
const OPENCODE_ZEN = [
  '┌  Add credential',
  '│',
  '●  Create an api key at https://opencode.ai/auth',
  '│',
  '◆  Enter your API key',
  '│  _',
  '└',
].join('\n');
const OPENCODE_NESTED_SELECT = [
  '┌  Add credential',
  '│',
  '◆  Select GitHub deployment type',
  '│  ● GitHub.com (Public)',
  '│  ○ GitHub Enterprise',
  '└',
].join('\n');
const OPENCODE_PROVIDER_SELECT = [
  '┌  Add credential',
  '│',
  '◆  Select provider',
  '│  Search: _',
  '│  ● OpenCode Zen (recommended)',
  '│  ○ OpenAI',
  '└',
].join('\n');

describe('CLAUDE_LOGIN_SPEC.detect', () => {
  it('asks for a pasted code once the OAuth URL is printed', () => {
    const cr = String.fromCharCode(13);
    const out = `visit: https://claude.com/cai/oauth/authorize?code=true&state=hKXe${cr}Paste code here`;
    expect(CLAUDE_LOGIN_SPEC.detect(out)).toEqual({
      kind: 'paste-code',
      url: 'https://claude.com/cai/oauth/authorize?code=true&state=hKXe',
    });
  });
  it('stays null while the login is still starting up', () => {
    expect(CLAUDE_LOGIN_SPEC.detect('Loading...\nsee https://claude.com/pricing')).toBeNull();
  });
  it('treats a rejection as retryable input', () => {
    expect(CLAUDE_LOGIN_SPEC.invalidInputPattern?.test('That code is invalid')).toBe(true);
  });
});

describe('CODEX_LOGIN_SPEC.detect', () => {
  it('reads the device URL and one-time code, and needs no typed input', () => {
    expect(CODEX_LOGIN_SPEC.detect(CODEX_TRANSCRIPT)).toEqual({
      kind: 'browser-only',
      url: 'https://auth.openai.com/codex/device',
      userCode: 'YQ16-PPHIE',
    });
  });
  it('waits for the code rather than showing a link the user cannot complete', () => {
    const urlOnly = CODEX_TRANSCRIPT.slice(0, CODEX_TRANSCRIPT.indexOf('2. Enter'));
    expect(CODEX_LOGIN_SPEC.detect(urlOnly)).toBeNull();
  });
  it('sees through ANSI styling', () => {
    const styled = CODEX_TRANSCRIPT.replace(
      'https://auth.openai.com/codex/device',
      `${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m`,
    );
    expect(CODEX_LOGIN_SPEC.detect(styled)).toMatchObject({ userCode: 'YQ16-PPHIE' });
  });
  it('does not mistake prose for a one-time code', () => {
    expect(extractCodexUserCode('expires in 15 minutes')).toBeNull();
    expect(extractCodexUserCode('  ABCD-12345  ')).toBe('ABCD-12345');
  });
});

describe('rejectionMessage', () => {
  it('tells a secret prompt to try another, not to paste a code', () => {
    expect(rejectionMessage({ kind: 'secret', label: 'API key' })).toBe(
      'that API key was not accepted — try another',
    );
  });
  it('tells a paste-code prompt to paste a fresh code', () => {
    expect(rejectionMessage({ kind: 'paste-code', url: 'https://x/oauth' })).toBe(
      'the code was not accepted — paste a fresh one',
    );
    expect(rejectionMessage(null)).toBe('the code was not accepted — paste a fresh one');
  });
});

describe('OPENCODE_LOGIN_SPEC.detect', () => {
  it('asks for the API key as a secret', () => {
    expect(OPENCODE_LOGIN_SPEC.detect(OPENCODE_API_KEY)).toEqual({
      kind: 'secret',
      label: 'API key',
    });
  });
  it('carries the "create a key at <url>" hint through to our prompt', () => {
    expect(OPENCODE_LOGIN_SPEC.detect(OPENCODE_ZEN)).toEqual({
      kind: 'secret',
      label: 'API key',
      hint: 'https://opencode.ai/auth',
    });
  });
  it('reports a nested per-provider select as unsupported', () => {
    expect(OPENCODE_LOGIN_SPEC.detect(OPENCODE_NESTED_SELECT)).toEqual({
      kind: 'unsupported',
      reason: 'it asks to Select GitHub deployment type',
    });
  });
  it('reports the provider picker as unsupported (we skip it with --provider)', () => {
    expect(OPENCODE_LOGIN_SPEC.detect(OPENCODE_PROVIDER_SELECT)).toMatchObject({
      kind: 'unsupported',
    });
  });
  it('reports a bad provider id distinctly, so the caller does not retry it', () => {
    const out = '┌  Add credential\nError: Unknown provider "nosuchprovider"';
    expect(OPENCODE_LOGIN_SPEC.detect(out)).toEqual({
      kind: 'unsupported',
      reason: 'unknown provider "nosuchprovider"',
    });
  });
  it('stays null while the login is still starting up', () => {
    expect(OPENCODE_LOGIN_SPEC.detect('┌  Add credential\n│')).toBeNull();
  });
});
