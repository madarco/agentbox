import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBindingLog } from '@agentbox/core';
import { appendHistoryBinding } from '../src/session-pointer.js';

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
  it('appends every captured session and never forgets one', () => {
    const p = logPath();
    appendHistoryBinding('claude', A, '/home/vscode/.claude/projects/-workspace/a.jsonl', p);
    // A concurrent `claude -p` (Phase 0's failure case for the single-slot pointer).
    appendHistoryBinding('claude', B, undefined, p);
    // The TUI's next Stop re-captures A: still bound, appended again.
    appendHistoryBinding('claude', A, undefined, p);
    const got = parseBindingLog(readFileSync(p, 'utf8')).map((b) => b.sessionId);
    expect(got).toEqual([A, B, A]);
  });

  it('skips a consecutive duplicate (every Stop re-captures the same id)', () => {
    const p = logPath();
    appendHistoryBinding('claude', A, undefined, p);
    appendHistoryBinding('claude', A, undefined, p);
    expect(parseBindingLog(readFileSync(p, 'utf8'))).toHaveLength(1);
  });

  it('refuses a malformed id', () => {
    const p = logPath();
    appendHistoryBinding('claude', '../../etc', undefined, p);
    expect(() => readFileSync(p, 'utf8')).toThrow();
  });
});
