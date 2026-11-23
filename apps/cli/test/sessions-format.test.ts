import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clip,
  compactCount,
  downloadTarget,
  sessionRow,
  shortId,
  turnLine,
} from '../src/lib/sessions-format.js';

const S = 'aaaaaaaa-1111-2222-3333-444444444444';

describe('downloadTarget', () => {
  it('lands every file under <dir>/<sessionId>/<path>', () => {
    expect(downloadTarget('/tmp/out', S, `projects/-workspace/${S}.jsonl`)).toBe(
      join(resolve('/tmp/out', S), `projects/-workspace/${S}.jsonl`),
    );
    expect(
      downloadTarget('/tmp/out', S, `projects/-workspace/${S}/subagents/agent-1.jsonl`),
    ).toContain(`${S}/projects/-workspace/${S}/subagents/agent-1.jsonl`);
  });

  it('refuses paths that escape the folder, absolute paths and odd session ids', () => {
    expect(downloadTarget('/tmp/out', S, '../../etc/passwd')).toBeNull();
    expect(downloadTarget('/tmp/out', S, 'projects/../../x')).toBeNull();
    expect(downloadTarget('/tmp/out', S, '/etc/passwd')).toBeNull();
    expect(downloadTarget('/tmp/out', '../x', 'a.jsonl')).toBeNull();
    expect(downloadTarget('/tmp/out', S, '')).toBeNull();
  });
});

describe('formatting', () => {
  it('shortens and clips', () => {
    expect(shortId(S)).toBe('aaaaaaaa');
    expect(clip('a\n  b   c', 10)).toBe('a b c');
    expect(clip('x'.repeat(20), 5)).toBe('xxxx…');
    expect(compactCount(950)).toBe('950');
    expect(compactCount(1500)).toBe('1.5k');
    expect(compactCount(25_000)).toBe('25k');
    expect(compactCount(2_500_000)).toBe('2.5M');
  });

  it('renders a session row and transcript lines', () => {
    const row = sessionRow({
      id: S,
      key: `claude:${S}`,
      agent: 'claude',
      boxId: 'b1',
      boxName: 'smoke',
      provider: 'docker',
      hostId: '0123456789abcdef',
      projectRepoUrl: null,
      parentSessionId: null,
      title: 'say hi',
      firstTs: null,
      lastTs: null,
      turns: 2,
      inputTokens: 1200,
      outputTokens: 30,
      createdAt: '2026-11-22T10:00:00Z',
      updatedAt: '2026-11-22T10:00:00Z',
    });
    expect(row.slice(0, 7)).toEqual([
      'aaaaaaaa',
      'claude',
      'smoke',
      'docker',
      '01234567',
      '2',
      '1.2k/30',
    ]);
    expect(row[8]).toBe('say hi');
    const base = {
      index: 0,
      ts: null,
      at: 0,
      path: 'projects/-workspace/x.jsonl',
      name: null,
      text: null,
    };
    expect(turnLine({ ...base, kind: 'turn', role: 'user', text: 'hello' })).toBe('> hello');
    expect(
      turnLine({ ...base, kind: 'tool', role: null, name: 'Bash', path: 'p/x/subagents/a.jsonl' }),
    ).toBe('    · Bash (subagent)');
  });
});
