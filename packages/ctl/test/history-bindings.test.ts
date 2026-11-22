import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBindingLog } from '@agentbox/core';
import { writeFileSync } from 'node:fs';
import { appendHistoryBinding, currentBoxId } from '../src/session-pointer.js';

const dirs: string[] = [];
const logPath = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ctl-bindings-'));
  dirs.push(d);
  return join(d, 'state', 'history-bindings.jsonl');
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';

describe('history binding log', () => {
  it('stamps every line with the box that wrote it (review B1)', () => {
    const p = logPath();
    appendHistoryBinding('claude', A, undefined, p, 'bx1');
    expect(parseBindingLog(readFileSync(p, 'utf8'))[0]).toMatchObject({
      boxId: 'bx1',
      sessionId: A,
    });
  });

  it('writes nothing when the box id is unknown (the line could never be shipped)', () => {
    const p = logPath();
    appendHistoryBinding('claude', A, undefined, p, '');
    expect(() => readFileSync(p, 'utf8')).toThrow();
  });

  it('re-appends the same session for a new box (a checkpoint-born box re-binds it)', () => {
    const p = logPath();
    appendHistoryBinding('claude', A, undefined, p, 'source');
    appendHistoryBinding('claude', A, undefined, p, 'bx1');
    expect(parseBindingLog(readFileSync(p, 'utf8')).map((b) => b.boxId)).toEqual(['source', 'bx1']);
  });

  it('reads the box id from the env, else from /etc/agentbox/box.env', () => {
    const d = mkdtempSync(join(tmpdir(), 'ctl-boxenv-'));
    dirs.push(d);
    const file = join(d, 'box.env');
    writeFileSync(file, "AGENTBOX_BOX_NAME='x'\nAGENTBOX_BOX_ID='bfile123'\n");
    expect(currentBoxId({ AGENTBOX_BOX_ID: 'benv' }, file)).toBe('benv');
    expect(currentBoxId({}, file)).toBe('bfile123');
    expect(currentBoxId({}, join(d, 'missing'))).toBe('');
  });

  it('appends every captured session and never forgets one', () => {
    const p = logPath();
    appendHistoryBinding('claude', A, '/home/vscode/.claude/projects/-workspace/a.jsonl', p, 'bx1');
    // A concurrent `claude -p` (Phase 0's failure case for the single-slot pointer).
    appendHistoryBinding('claude', B, undefined, p, 'bx1');
    // The TUI's next Stop re-captures A: still bound, appended again.
    appendHistoryBinding('claude', A, undefined, p, 'bx1');
    const got = parseBindingLog(readFileSync(p, 'utf8')).map((b) => b.sessionId);
    expect(got).toEqual([A, B, A]);
  });

  it('skips a consecutive duplicate (every Stop re-captures the same id)', () => {
    const p = logPath();
    appendHistoryBinding('claude', A, undefined, p, 'bx1');
    appendHistoryBinding('claude', A, undefined, p, 'bx1');
    expect(parseBindingLog(readFileSync(p, 'utf8'))).toHaveLength(1);
  });

  it('refuses a malformed id', () => {
    const p = logPath();
    appendHistoryBinding('claude', '../../etc', undefined, p, 'bx1');
    expect(() => readFileSync(p, 'utf8')).toThrow();
  });
});
