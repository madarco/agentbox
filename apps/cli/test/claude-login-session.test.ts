import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupStaleSessions,
  extractOAuthUrl,
  findLiveSession,
  findPendingSession,
  loginSessionDir,
  readLoginState,
  selectLoginMode,
  takeLoginCode,
  writeLoginCode,
  writeLoginRequest,
  writeLoginState,
} from '../src/lib/claude-login-session.js';

const DEAD_PID = 2 ** 30; // astronomically unlikely to be a live process

describe('selectLoginMode', () => {
  it('--code always wins, even with a TTY', () => {
    expect(selectLoginMode({ isTTY: true, headless: false, code: true })).toBe('code');
    expect(selectLoginMode({ isTTY: false, headless: true, code: true })).toBe('code');
  });
  it('non-TTY (no code) → headless', () => {
    expect(selectLoginMode({ isTTY: false, headless: false, code: false })).toBe('headless');
  });
  it('explicit --headless in a TTY → headless', () => {
    expect(selectLoginMode({ isTTY: true, headless: true, code: false })).toBe('headless');
  });
  it('plain TTY → interactive', () => {
    expect(selectLoginMode({ isTTY: true, headless: false, code: false })).toBe('interactive');
  });
});

describe('extractOAuthUrl', () => {
  it('pulls a plain claude.ai oauth URL out of surrounding prose', () => {
    expect(extractOAuthUrl('Open https://claude.ai/oauth/authorize?code=1&x=2 to continue')).toBe(
      'https://claude.ai/oauth/authorize?code=1&x=2',
    );
  });
  it('handles a console.anthropic.com host', () => {
    expect(extractOAuthUrl('go: https://console.anthropic.com/oauth/authorize?a=b now')).toBe(
      'https://console.anthropic.com/oauth/authorize?a=b',
    );
  });
  it('handles the current claude.com/cai/oauth host and stops at a trailing CR', () => {
    const cr = String.fromCharCode(13);
    const line = `visit: https://claude.com/cai/oauth/authorize?code=true&state=hKXe${cr}Paste code here`;
    expect(extractOAuthUrl(line)).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&state=hKXe',
    );
  });
  it('does not match an unrelated claude.com link (no oauth in path)', () => {
    expect(extractOAuthUrl('see https://claude.com/pricing for details')).toBeNull();
  });
  it('strips ANSI color codes around the URL', () => {
    const esc = String.fromCharCode(27);
    const styled = `${esc}[36mhttps://claude.ai/oauth/authorize?foo=bar${esc}[0m`;
    expect(extractOAuthUrl(styled)).toBe('https://claude.ai/oauth/authorize?foo=bar');
  });
  it('stops at the BEL of an OSC-8 hyperlink (no swallowing trailing text)', () => {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const osc = `${esc}]8;;https://claude.ai/oauth/authorize?h=1${bel}click here${esc}]8;;${bel}`;
    expect(extractOAuthUrl(osc)).toBe('https://claude.ai/oauth/authorize?h=1');
  });
  it('trims trailing punctuation', () => {
    expect(extractOAuthUrl('URL: https://claude.ai/oauth/authorize?z=9.')).toBe(
      'https://claude.ai/oauth/authorize?z=9',
    );
  });
  it('does not treat literal [brackets] in prose as escapes', () => {
    expect(extractOAuthUrl('config [debug] mode; see https://claude.ai/oauth/x?y=1')).toBe(
      'https://claude.ai/oauth/x?y=1',
    );
  });
  it('returns null when there is no matching URL', () => {
    expect(extractOAuthUrl('nothing here, just [brackets] and https://example.com/x')).toBeNull();
  });
});

describe('login session state IPC', () => {
  let home: string;
  const origHome = process.env['AGENTBOX_HOME'];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentbox-login-'));
    process.env['AGENTBOX_HOME'] = home;
  });
  afterEach(async () => {
    if (origHome === undefined) delete process.env['AGENTBOX_HOME'];
    else process.env['AGENTBOX_HOME'] = origHome;
    await rm(home, { recursive: true, force: true });
  });

  it('round-trips request + state and never leaves a temp file', async () => {
    writeLoginRequest('s1', { image: 'img:1', extraArgs: ['--claudeai'], cwd: '/w', createdAt: 'T' });
    writeLoginState('s1', { phase: 'awaiting-code', url: 'https://claude.ai/oauth/x', pid: process.pid, createdAt: 'T' });
    const st = readLoginState('s1');
    expect(st?.phase).toBe('awaiting-code');
    expect(st?.url).toBe('https://claude.ai/oauth/x');
    expect(st?.updatedAt).toBeTypeOf('string');
    const entries = (await import('node:fs/promises')).readdir(loginSessionDir('s1'));
    expect((await entries).some((f) => f.includes('.tmp.'))).toBe(false);
  });

  it('takeLoginCode reads and consumes the code', () => {
    writeLoginCode('s2', '  abc123  ');
    expect(takeLoginCode('s2')).toBe('abc123');
    expect(takeLoginCode('s2')).toBeNull(); // consumed
    expect(existsSync(join(loginSessionDir('s2'), 'code'))).toBe(false);
  });

  it('findPendingSession returns only a live awaiting-code session', () => {
    // dead worker → ignored even though it is awaiting-code
    writeLoginState('dead', { phase: 'awaiting-code', url: 'https://claude.ai/oauth/d', pid: DEAD_PID, createdAt: 'T' });
    expect(findPendingSession()).toBeNull();
    // live worker → found
    writeLoginState('live', { phase: 'awaiting-code', url: 'https://claude.ai/oauth/l', pid: process.pid, createdAt: 'T' });
    expect(findPendingSession()?.id).toBe('live');
  });

  it('does not return a done/error session as pending', () => {
    writeLoginState('done', { phase: 'done', pid: process.pid, createdAt: 'T' });
    expect(findPendingSession()).toBeNull();
  });

  it('findLiveSession matches a live `starting` session (before its URL) but findPendingSession does not', () => {
    writeLoginState('boot', { phase: 'starting', pid: process.pid, createdAt: 'T' });
    expect(findPendingSession()).toBeNull(); // no URL yet → not deliverable
    expect(findLiveSession()?.id).toBe('boot'); // but it IS live → blocks a 2nd worker
  });

  it('findLiveSession matches a live `exchanging` session but ignores dead/terminal ones', () => {
    writeLoginState('xchg', { phase: 'exchanging', url: 'u', pid: process.pid, createdAt: 'T' });
    expect(findLiveSession()?.id).toBe('xchg');
    writeLoginState('xchg', { phase: 'done', pid: process.pid, createdAt: 'T' });
    expect(findLiveSession()).toBeNull(); // terminal → not live
    writeLoginState('xchg', { phase: 'exchanging', url: 'u', pid: DEAD_PID, createdAt: 'T' });
    expect(findLiveSession()).toBeNull(); // dead worker → not live
  });
});

describe('cleanupStaleSessions', () => {
  let home: string;
  const origHome = process.env['AGENTBOX_HOME'];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentbox-login-clean-'));
    process.env['AGENTBOX_HOME'] = home;
  });
  afterEach(async () => {
    if (origHome === undefined) delete process.env['AGENTBOX_HOME'];
    else process.env['AGENTBOX_HOME'] = origHome;
    await rm(home, { recursive: true, force: true });
  });

  it('reaps a crashed worker (dead pid, non-terminal phase)', () => {
    writeLoginState('crash', { phase: 'awaiting-code', url: 'u', pid: DEAD_PID, createdAt: 'T' });
    cleanupStaleSessions();
    expect(existsSync(loginSessionDir('crash'))).toBe(false);
  });

  it('reaps an old terminal session but keeps a fresh live one', () => {
    // Fresh live awaiting-code (updatedAt = now) → kept.
    writeLoginState('live', { phase: 'awaiting-code', url: 'u', pid: process.pid, createdAt: 'T' });
    // Old done session → reaped (its updatedAt is now, so advance the clock past TERMINAL_MAX_AGE).
    writeLoginState('olddone', { phase: 'done', pid: process.pid, createdAt: 'T' });
    cleanupStaleSessions(Date.now() + 6 * 60_000);
    expect(existsSync(loginSessionDir('olddone'))).toBe(false);
    expect(existsSync(loginSessionDir('live'))).toBe(true);
  });
});
