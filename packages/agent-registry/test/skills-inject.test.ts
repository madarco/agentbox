import { describe, expect, it } from 'vitest';
import { BOX_SKILLS_LIBRARY_DIR, agentLaunchFlags, agentLaunchPrelude } from '@agentbox/core';
import { BUILTIN_AGENT_SPECS } from '../src/index.js';
import { OPENCLAW_CONFIG_MERGE_PROGRAM } from '../src/specs/openclaw.js';

const spec = (id: string) => {
  const s = BUILTIN_AGENT_SPECS.find((x) => x.id === id);
  if (!s) throw new Error(`no spec ${id}`);
  return s;
};

describe('every built-in agent declares how the skills library reaches it', () => {
  it('uses the injection measured in Phase 0', () => {
    expect(spec('claude').skills?.inject).toEqual({
      kind: 'dir',
      path: '/etc/claude-code/.claude/skills',
    });
    expect(spec('codex').skills?.inject).toEqual({ kind: 'dir', path: '/etc/codex/skills' });
    expect(spec('opencode').skills?.inject).toEqual({
      kind: 'dir',
      path: '/home/vscode/.opencode/skills',
    });
    expect(spec('pi').skills?.inject.kind).toBe('flag');
    expect(spec('openclaw').skills?.inject).toEqual({
      kind: 'config',
      jsonPath: ['skills', 'load', 'extraDirs'],
    });
  });

  it("pi's launch adds --skill <library> after its declared flags", () => {
    expect(agentLaunchFlags(spec('pi'))).toEqual([
      ...(spec('pi').launchFlags ?? []),
      '--skill',
      BOX_SKILLS_LIBRARY_DIR,
    ]);
    expect(agentLaunchFlags(spec('codex'))).toEqual(spec('codex').launchFlags);
  });

  it('only a flag injection gets a launch prelude, which creates the library dir', () => {
    expect(agentLaunchPrelude(spec('pi'))).toBe(`mkdir -p ${BOX_SKILLS_LIBRARY_DIR} 2>/dev/null; `);
    for (const id of ['claude', 'codex', 'opencode', 'openclaw']) {
      expect(agentLaunchPrelude(spec(id))).toBe('');
    }
  });

  it('a malformed plugin flag injection adds nothing instead of failing the launch', () => {
    const bad = { launchFlags: ['-a'], skills: { dirs: [], inject: { kind: 'flag' } } };
    expect(agentLaunchFlags(bad as never)).toEqual(['-a']);
  });

  it("openclaw's boot task merges the library dir next to AgentBox's own skills dir", () => {
    const task = spec('openclaw').service?.tasks?.find((t) => t.name === 'openclaw-agentbox-env');
    expect(task?.command).toContain(`/opt/agentbox/skills:${BOX_SKILLS_LIBRARY_DIR}`);
    expect(OPENCLAW_CONFIG_MERGE_PROGRAM).toContain(".split(':')");
  });
});
