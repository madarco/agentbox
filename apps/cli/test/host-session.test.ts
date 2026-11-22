import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeClaudeProjectsKey } from '@agentbox/sandbox-core';
import {
  detectHostSession,
  findAncestorPid,
  type HostSessionDeps,
} from '../src/lib/host-session.js';

// Every filesystem and process read goes through an injected seam: apps/cli tests
// have no HOME isolation, so nothing here may touch the real ~/.claude.
const HOME = '/home/u';
const MACHINE = '11111111-2222-4333-8444-555555555555';
const ID = '5edc0ee0-ce9a-4e30-962d-bc630388d8bc';
const NOW = 1_800_000_000_000;

function transcriptDir(dir: string): string {
  return join(HOME, '.claude', 'projects', encodeClaudeProjectsKey(dir));
}

function deps(over: HostSessionDeps & { files?: Record<string, number> } = {}): HostSessionDeps {
  const files = over.files ?? {};
  return {
    home: HOME,
    cwd: '/work/repo',
    hostname: () => 'laptop',
    machineId: () => MACHINE,
    now: () => NOW,
    exists: (p) => p in files,
    listDir: (dir) =>
      Object.keys(files)
        .filter((f) => f.startsWith(`${dir}/`))
        .map((f) => f.slice(dir.length + 1)),
    mtimeMs: (p) => files[p],
    ps: () => undefined,
    ...over,
  };
}

describe('detectHostSession: claude', () => {
  it('uses the env session id when its transcript exists, with CLAUDE_PID', () => {
    const files = { [join(transcriptDir('/work/repo'), `${ID}.jsonl`)]: NOW };
    const hint = detectHostSession(
      deps({
        env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: ID, CLAUDE_PID: '4321' },
        files,
      }),
    );
    expect(hint).toEqual({
      agent: 'claude',
      sessionId: ID,
      cwd: '/work/repo',
      pid: 4321,
      host: 'laptop',
      machineId: MACHINE,
    });
  });

  it('walks up to the folder the session was started in', () => {
    const files = { [join(transcriptDir('/work/repo'), `${ID}.jsonl`)]: NOW };
    const hint = detectHostSession(
      deps({ cwd: '/work/repo/packages/a', env: { CLAUDE_CODE_SESSION_ID: ID }, files }),
    );
    expect(hint?.cwd).toBe('/work/repo');
  });

  it('finds the session started in a sibling folder from the cwd its transcript records', () => {
    const file = join(transcriptDir('/work/repo'), `${ID}.jsonl`);
    const files = { [file]: NOW };
    const head = [
      '{"type":"permission-mode"}',
      JSON.stringify({ type: 'user', cwd: '/work/repo', sessionId: ID }),
    ].join('\n');
    const hint = detectHostSession(
      deps({
        cwd: '/work/other',
        env: { CLAUDE_CODE_SESSION_ID: ID },
        files,
        listDir: (dir) =>
          dir === join(HOME, '.claude', 'projects') ? [encodeClaudeProjectsKey('/work/repo')] : [],
        readHead: (p) => (p === file ? head : undefined),
      }),
    );
    expect(hint).toMatchObject({ agent: 'claude', sessionId: ID, cwd: '/work/repo' });
  });

  it("falls back to the one recent session when the env id is a subagent's", () => {
    const dir = transcriptDir('/work/repo');
    const files = {
      [join(dir, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl')]: NOW - 60_000,
      [join(dir, 'agent-xyz.jsonl')]: NOW - 1_000,
      [join(dir, 'old.jsonl')]: NOW - 60 * 60_000,
    };
    const hint = detectHostSession(deps({ env: { CLAUDE_CODE_SESSION_ID: 'subagent-id' }, files }));
    expect(hint?.sessionId).toBe('aaaaaaaa-1111-2222-3333-444444444444');
  });

  it('sends nothing when two sessions in the folder are recent', () => {
    const dir = transcriptDir('/work/repo');
    const files = { [join(dir, 'a.jsonl')]: NOW - 1_000, [join(dir, 'b.jsonl')]: NOW - 2_000 };
    expect(detectHostSession(deps({ env: { CLAUDECODE: '1' }, files }))).toBeUndefined();
  });

  it('passes a valid AGENTBOX_MANAGER hint and drops a malformed one', () => {
    const files = { [join(transcriptDir('/work/repo'), `${ID}.jsonl`)]: NOW };
    const env = { CLAUDE_CODE_SESSION_ID: ID };
    expect(
      detectHostSession(deps({ env: { ...env, AGENTBOX_MANAGER: '0123456789abcdef' }, files }))
        ?.managerId,
    ).toBe('0123456789abcdef');
    expect(
      detectHostSession(deps({ env: { ...env, AGENTBOX_MANAGER: '--evil' }, files })),
    ).not.toHaveProperty('managerId');
  });

  it('names the AgentBox tmux session its pane belongs to, and no other session', () => {
    const files = { [join(transcriptDir('/work/repo'), `${ID}.jsonl`)]: NOW };
    const env = { CLAUDE_CODE_SESSION_ID: ID, TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%0' };
    const asked: string[] = [];
    const sessionOf =
      (name: string) =>
      (pane: string): string => {
        asked.push(pane);
        return name;
      };
    expect(
      detectHostSession(
        deps({ env, files, tmuxSessionOf: sessionOf('agentbox-manager-1020d6ffc6aa4e07') }),
      ),
    ).toMatchObject({ tmuxPane: '%0', tmuxSession: 'agentbox-manager-1020d6ffc6aa4e07' });
    expect(asked).toEqual(['%0']);
    expect(
      detectHostSession(deps({ env, files, tmuxSessionOf: sessionOf('work') })),
    ).not.toHaveProperty('tmuxSession');
    // Without TMUX (a session in Claude's background daemon) tmux is never asked.
    asked.length = 0;
    const outside = { CLAUDE_CODE_SESSION_ID: ID, TMUX_PANE: '%0' };
    expect(
      detectHostSession(
        deps({
          env: outside,
          files,
          tmuxSessionOf: sessionOf('agentbox-manager-1020d6ffc6aa4e07'),
        }),
      ),
    ).not.toHaveProperty('tmuxSession');
    expect(asked).toEqual([]);
  });
});

describe('detectHostSession: codex and refusals', () => {
  it('reads CODEX_THREAD_ID and finds the pid from the nearest codex ancestor', () => {
    const tree: Record<number, { ppid: number; comm: string }> = {
      500: { ppid: 400, comm: '/bin/zsh' },
      400: { ppid: 300, comm: '/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex' },
      300: { ppid: 1, comm: 'node' },
    };
    const hint = detectHostSession(
      deps({
        env: { CODEX_THREAD_ID: '01a09ad5-8f51-7ec0-b8f4-2daa8be67500' },
        ppid: 500,
        ps: (pid) => tree[pid],
      }),
    );
    expect(hint).toMatchObject({ agent: 'codex', pid: 400, cwd: '/work/repo' });
  });

  it('has no pid when ps is not permitted (the codex sandbox), and still names the session', () => {
    const hint = detectHostSession(
      deps({ env: { CODEX_THREAD_ID: '01a09ad5-8f51-7ec0-b8f4-2daa8be67500' }, ppid: 500 }),
    );
    expect(hint).toMatchObject({ agent: 'codex' });
    expect(hint).not.toHaveProperty('pid');
  });

  it('picks the nearest agent when one runs inside the other and inherited its variables', () => {
    const tree: Record<number, { ppid: number; comm: string }> = {
      100: { ppid: 90, comm: '/bin/zsh' },
      90: { ppid: 80, comm: '/usr/local/bin/codex' },
      80: { ppid: 70, comm: 'claude' },
    };
    const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: ID, CODEX_THREAD_ID: 'thread-1' };
    const inner = detectHostSession(deps({ env, ppid: 100, ps: (pid) => tree[pid] }));
    expect(inner).toMatchObject({ agent: 'codex', sessionId: 'thread-1', pid: 90 });

    const refused = detectHostSession(deps({ env, ppid: 100, ps: () => undefined }));
    expect(refused).toMatchObject({ agent: 'codex', sessionId: 'thread-1' });

    const files = { [join(transcriptDir('/work/repo'), `${ID}.jsonl`)]: NOW };
    const outerFirst = { 100: { ppid: 80, comm: 'zsh' }, 80: { ppid: 90, comm: 'claude' } };
    const claude = detectHostSession(
      deps({ env, files, ppid: 100, ps: (pid) => outerFirst[pid as 100 | 80] }),
    );
    expect(claude).toMatchObject({ agent: 'claude', sessionId: ID });
  });

  it('refuses inside a box and outside any agent session', () => {
    expect(
      detectHostSession(deps({ env: { CODEX_THREAD_ID: 'x', AGENTBOX_RELAY_URL: 'http://r' } })),
    ).toBeUndefined();
    expect(detectHostSession(deps({ env: {} }))).toBeUndefined();
  });

  it('stops the ancestor walk at the time budget', () => {
    let t = 0;
    const ps = (pid: number): { ppid: number; comm: string } => {
      t += 600;
      return { ppid: pid + 1, comm: 'sh' };
    };
    expect(findAncestorPid('codex', 10, ps, () => t)).toBeUndefined();
    expect(t).toBeLessThanOrEqual(1200);
  });
});
