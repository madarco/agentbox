import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeClaudeProjectsKey } from '@agentbox/sandbox-core';
import {
  buildManagerArgv,
  sendKeysLiteralArgv,
  sendKeysToManager,
  sessionTurn,
  upsertDetectedManager,
} from '../src/workspaces/manager.js';
import { addWorkspace } from '../src/workspaces/workspace-store.js';

const ID = '5edc0ee0-ce9a-4e30-962d-bc630388d8bc';
const CODEX_ID = '01a09af5-5084-7991-b207-dd0d895f8e9c';
const CWD = '/work/repo';

function jsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

const user = (promptId: string | undefined, content: unknown, extra: object = {}) => ({
  type: 'user',
  ...(promptId ? { promptId } : {}),
  message: { role: 'user', content },
  ...extra,
});

async function claudeTranscript(home: string): Promise<string> {
  const dir = join(home, '.claude', 'projects', encodeClaudeProjectsKey(CWD));
  await mkdir(dir, { recursive: true });
  return join(dir, `${ID}.jsonl`);
}

describe('sessionTurn', () => {
  it('counts claude turns by prompt id, skipping meta rows, wrappers and tool results', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbox-turn-'));
    const file = await claudeTranscript(home);
    await writeFile(
      file,
      jsonl([
        user(undefined, '<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
        user(undefined, '<command-name>/clear</command-name>'),
        user('p1', 'plan the checkout work'),
        user('p1', [{ type: 'tool_result', content: 'ok' }]),
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
        user('p2', [{ type: 'text', text: 'split T-4 into two' }]),
        user('p2', [{ type: 'tool_result', content: 'ok' }]),
      ]),
    );
    expect(await sessionTurn('claude', CWD, ID, home)).toEqual({
      turn: 2,
      prompt: 'split T-4 into two',
    });
  });

  it('reads only what was appended since the last call, including a line split across calls', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbox-turn-'));
    const file = await claudeTranscript(home);
    await writeFile(file, jsonl([user('p1', 'first')]));
    expect((await sessionTurn('claude', CWD, ID, home))?.turn).toBe(1);
    const next = JSON.stringify(user('p2', 'second'));
    await appendFile(file, next.slice(0, 20));
    expect((await sessionTurn('claude', CWD, ID, home))?.turn).toBe(1);
    await appendFile(file, next.slice(20) + '\n' + JSON.stringify(user('p3', 'third')) + '\n');
    expect(await sessionTurn('claude', CWD, ID, home)).toEqual({ turn: 3, prompt: 'third' });
  });

  it('counts codex turns by turn_context and takes the last user_message as the prompt', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbox-turn-'));
    const dir = join(home, '.codex', 'sessions', '2026', '09', '13');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `rollout-2026-09-13T10-00-00-${CODEX_ID}.jsonl`);
    await writeFile(
      file,
      jsonl([
        { type: 'session_meta', payload: { cwd: CWD } },
        { type: 'turn_context', payload: {} },
        { type: 'event_msg', payload: { type: 'user_message', message: 'add retries' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
        { type: 'turn_context', payload: {} },
        { type: 'event_msg', payload: { type: 'user_message', message: 'now the tests' } },
      ]),
    );
    expect(await sessionTurn('codex', CWD, CODEX_ID, home)).toEqual({
      turn: 2,
      prompt: 'now the tests',
    });
    await appendFile(
      file,
      jsonl([
        { type: 'turn_context', payload: {} },
        { type: 'event_msg', payload: { type: 'user_message', message: 'ship it' } },
      ]),
    );
    expect(await sessionTurn('codex', CWD, CODEX_ID, home)).toEqual({ turn: 3, prompt: 'ship it' });
  });

  it('answers undefined for a missing transcript or an agent whose store is not read', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbox-turn-'));
    expect(await sessionTurn('claude', CWD, ID, home)).toBeUndefined();
    expect(await sessionTurn('opencode', CWD, ID, home)).toBeUndefined();
  });
});

describe('sessionTurn concurrency', () => {
  it('counts each turn once when calls for one transcript overlap', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbox-turn-par-'));
    const file = await claudeTranscript(home);
    // Rows without a prompt id are counted one by one, not deduped by id: the
    // shape two overlapping reads of the same bytes would count twice.
    await writeFile(
      file,
      jsonl([user(undefined, 'first'), user(undefined, 'second'), user(undefined, 'third')]),
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, () => sessionTurn('claude', CWD, ID, home)),
    );
    expect(results).toEqual(Array.from({ length: 6 }, () => ({ turn: 3, prompt: 'third' })));
    await appendFile(file, jsonl([user(undefined, 'fourth')]));
    const again = await Promise.all([
      sessionTurn('claude', CWD, ID, home),
      sessionTurn('claude', CWD, ID, home),
    ]);
    expect(again).toEqual([
      { turn: 4, prompt: 'fourth' },
      { turn: 4, prompt: 'fourth' },
    ]);
  });
});

describe('manager messages', () => {
  it('resumes with the message as the prompt, never letting it read as a flag', () => {
    expect(buildManagerArgv('claude', ID, 'Approved: merge PR #409')).toEqual([
      'claude',
      '--resume',
      ID,
      'Approved: merge PR #409',
    ]);
    expect(buildManagerArgv('codex', ID, 'go')).toEqual(['codex', 'resume', ID, 'go']);
    expect(buildManagerArgv('claude', ID, '--dangerously-skip-permissions')).toEqual([
      'claude',
      '--resume',
      ID,
      ' --dangerously-skip-permissions',
    ]);
    expect(buildManagerArgv('claude', ID)).toEqual(['claude', '--resume', ID]);
  });

  it('types the text literally, then submits with a separate Enter', async () => {
    const calls: string[][] = [];
    const exec = async (_file: string, args: string[]) => {
      calls.push(args);
      return { exitCode: 0 };
    };
    await sendKeysToManager(
      { session: 'agentbox-manager-abc' },
      'line one\nline two',
      exec,
      async () => {},
    );
    expect(calls).toEqual([
      ['send-keys', '-t', '=agentbox-manager-abc:', '-l', '--', 'line one line two'],
      ['send-keys', '-t', '=agentbox-manager-abc:', 'Enter'],
    ]);
    calls.length = 0;
    await sendKeysToManager({ pane: '%12' }, 'hi', exec, async () => {});
    expect(calls[0]).toEqual(['send-keys', '-t', '%12', '-l', '--', 'hi']);
    await expect(
      sendKeysToManager({ pane: 'x; rm' }, 'hi', exec, async () => {}),
    ).rejects.toThrow();
  });

  it('keeps a leading dash and a trailing semicolon literal', () => {
    expect(sendKeysLiteralArgv('%1', '-R reset please')).toEqual([
      'send-keys',
      '-t',
      '%1',
      '-l',
      '--',
      '-R reset please',
    ]);
    expect(sendKeysLiteralArgv('%1', 'merge PR #409;').at(-1)).toBe('merge PR #409\\;');
    expect(sendKeysLiteralArgv('%1', 'a; b').at(-1)).toBe('a; b');
  });

  it('stores the pane a detected session reported, and reports a new session id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbox-pane-'));
    const ws = await addWorkspace(
      { host: hostname(), root, projects: [] },
      { register: async () => {} },
    );
    const first = await upsertDetectedManager(ws.id, {
      agent: 'claude',
      sessionId: ID,
      cwd: root,
      tmuxPane: '%3',
    });
    expect(first).toMatchObject({ created: true, sessionChanged: false });
    expect(first.manager.tmuxPane).toBe('%3');
    const again = await upsertDetectedManager(ws.id, { agent: 'claude', sessionId: ID, cwd: root });
    expect(again).toMatchObject({ created: false, sessionChanged: false });
    expect(again.manager.tmuxPane).toBeUndefined();
  });
});
