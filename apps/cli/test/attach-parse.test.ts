import { describe, expect, it } from 'vitest';
import { parseTmuxAgentSessions } from '../src/commands/attach.js';

describe('parseTmuxAgentSessions', () => {
  it('keeps only the default agent session names', () => {
    const out = parseTmuxAgentSessions(
      ['claude 100', 'codex 200', 'shell-1 50', 'opencode 300', ''].join('\n'),
    );
    expect(out.map((s) => s.kind)).toEqual(['claude', 'codex', 'opencode']);
    expect(out.map((s) => s.startedAt)).toEqual([100, 200, 300]);
  });

  it('filterName restricts to a single tmux name and defaults kind to claude on non-default override', () => {
    const out = parseTmuxAgentSessions(
      ['my-claude 100', 'codex 200', 'opencode 300'].join('\n'),
      'my-claude',
    );
    expect(out).toEqual([{ kind: 'claude', sessionName: 'my-claude', startedAt: 100 }]);
  });

  it('filterName matching a default name keeps that name and its kind', () => {
    const out = parseTmuxAgentSessions(
      ['claude 100', 'codex 200'].join('\n'),
      'codex',
    );
    expect(out).toEqual([{ kind: 'codex', sessionName: 'codex', startedAt: 200 }]);
  });

  it('startedAt is null when the timestamp is missing or unparseable', () => {
    const out = parseTmuxAgentSessions(['claude', 'codex zz'].join('\n'));
    expect(out).toEqual([
      { kind: 'claude', sessionName: 'claude', startedAt: null },
      { kind: 'codex', sessionName: 'codex', startedAt: null },
    ]);
  });
});
