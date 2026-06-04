import { describe, expect, it } from 'vitest';
import type { BoxRecord, ExecOptions, ExecResult, Provider } from '@agentbox/core';
import {
  captureSession,
  listSessions,
  paneInfo,
  resizeWindow,
  sendKey,
  sendLiteral,
} from '../src/lib/drive/tmux.js';
import { resolveDriveSession, SessionNotFoundError } from '../src/lib/drive/session.js';

type ExecCall = { argv: string[]; opts?: ExecOptions };

function stubProvider(
  responder: (argv: string[]) => ExecResult | Promise<ExecResult>,
): { provider: Provider; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const provider = {
    name: 'docker',
    async probeState(): Promise<'running'> {
      return 'running';
    },
    async resume(): Promise<void> {},
    async exec(_box: BoxRecord, argv: string[], opts?: ExecOptions): Promise<ExecResult> {
      calls.push({ argv, opts });
      return await responder(argv);
    },
  } as unknown as Provider;
  return { provider, calls };
}

const box = { id: 'b', name: 'test', container: 'agentbox-test', provider: 'docker' } as unknown as BoxRecord;

describe('captureSession', () => {
  it('uses `-p` plain by default, scoped to the session', async () => {
    const { provider, calls } = stubProvider(() => ({ exitCode: 0, stdout: 'hi\n', stderr: '' }));
    const out = await captureSession(provider, box, 'claude');
    expect(out).toBe('hi');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(['tmux', 'capture-pane', '-p', '-t', 'claude']);
    expect(calls[0]!.opts).toEqual({ user: 'vscode' });
  });

  it('switches to `-pe` for --ansi and applies row range', async () => {
    const { provider, calls } = stubProvider(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    await captureSession(provider, box, 'codex', { ansi: true, rows: { from: -50, to: 10 } });
    expect(calls[0]!.argv).toEqual([
      'tmux',
      'capture-pane',
      '-pe',
      '-t',
      'codex',
      '-S',
      '-50',
      '-E',
      '10',
    ]);
  });

  it('surfaces tmux failures with context', async () => {
    const { provider } = stubProvider(() => ({ exitCode: 1, stdout: '', stderr: "can't find session" }));
    await expect(captureSession(provider, box, 'ghost')).rejects.toThrow(
      /capture-pane.*ghost.*can't find session/,
    );
  });
});

describe('sendLiteral / sendKey / resizeWindow', () => {
  it('send-keys -l passes the literal verbatim', async () => {
    const { provider, calls } = stubProvider(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    await sendLiteral(provider, box, 'claude', '\x01q');
    expect(calls[0]!.argv).toEqual([
      'tmux',
      'send-keys',
      '-t',
      'claude',
      '-l',
      '--',
      '\x01q',
    ]);
  });

  it('skips the tmux call when literal is empty', async () => {
    const { provider, calls } = stubProvider(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    await sendLiteral(provider, box, 'claude', '');
    expect(calls).toHaveLength(0);
  });

  it('sendKey uses key-table translation (no -l)', async () => {
    const { provider, calls } = stubProvider(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    await sendKey(provider, box, 'claude', 'Enter');
    expect(calls[0]!.argv).toEqual(['tmux', 'send-keys', '-t', 'claude', 'Enter']);
  });

  it('resizeWindow builds the right argv', async () => {
    const { provider, calls } = stubProvider(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    await resizeWindow(provider, box, 'claude', 120, 40);
    expect(calls[0]!.argv).toEqual([
      'tmux',
      'resize-window',
      '-t',
      'claude',
      '-x',
      '120',
      '-y',
      '40',
    ]);
  });
});

describe('paneInfo', () => {
  it('parses the comma-separated display-message output', async () => {
    const { provider, calls } = stubProvider(() => ({
      exitCode: 0,
      stdout: '120,40,7,3',
      stderr: '',
    }));
    const info = await paneInfo(provider, box, 'claude');
    expect(info).toEqual({ cols: 120, rows: 40, cursor: { x: 7, y: 3 } });
    expect(calls[0]!.argv).toEqual([
      'tmux',
      'display-message',
      '-p',
      '-t',
      'claude',
      '#{pane_width},#{pane_height},#{cursor_x},#{cursor_y}',
    ]);
  });

  it('throws if tmux returns unexpected output', async () => {
    const { provider } = stubProvider(() => ({ exitCode: 0, stdout: 'weird', stderr: '' }));
    await expect(paneInfo(provider, box, 'claude')).rejects.toThrow(/unexpected output/);
  });
});

describe('listSessions', () => {
  it('parses `tmux list-sessions -F #{session_name}` output', async () => {
    const { provider } = stubProvider(() => ({
      exitCode: 0,
      stdout: 'claude\ncodex\n\nopencode\n',
      stderr: '',
    }));
    const names = await listSessions(provider, box);
    expect(names).toEqual(['claude', 'codex', 'opencode']);
  });

  it('returns [] when the tmux server is not running', async () => {
    const { provider } = stubProvider(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'no server running',
    }));
    expect(await listSessions(provider, box)).toEqual([]);
  });
});

describe('resolveDriveSession', () => {
  function sessionsProvider(sessions: string[]): Provider {
    return stubProvider(() => ({ exitCode: 0, stdout: sessions.join('\n'), stderr: '' })).provider;
  }

  it('prefers claude over codex/opencode when several are running', async () => {
    const provider = sessionsProvider(['opencode', 'codex', 'claude']);
    const r = await resolveDriveSession(provider, box, undefined);
    expect(r.name).toBe('claude');
  });

  it('falls back to codex when claude is absent', async () => {
    const provider = sessionsProvider(['codex', 'opencode']);
    const r = await resolveDriveSession(provider, box, undefined);
    expect(r.name).toBe('codex');
  });

  it('auto-picks the only session when no agent session is running', async () => {
    const provider = sessionsProvider(['shell']);
    const r = await resolveDriveSession(provider, box, undefined);
    expect(r.name).toBe('shell');
  });

  it('errors with the running list when no agent session and 2+ candidates', async () => {
    const provider = sessionsProvider(['shell', 'work']);
    await expect(resolveDriveSession(provider, box, undefined)).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('honors explicit --session when it matches a running session', async () => {
    const provider = sessionsProvider(['claude', 'codex']);
    const r = await resolveDriveSession(provider, box, 'codex');
    expect(r.name).toBe('codex');
  });

  it('rejects an explicit --session that is not running', async () => {
    const provider = sessionsProvider(['claude']);
    await expect(resolveDriveSession(provider, box, 'codex')).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });
});
