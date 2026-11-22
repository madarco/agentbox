import { describe, expect, it } from 'vitest';
import { BOX_SKILLS_LIBRARY_DIR, agentLaunchFlags, agentRunEnv } from '@agentbox/core';
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
    expect(spec('opencode').skills?.inject.kind).toBe('env');
    expect(spec('pi').skills?.inject.kind).toBe('flag');
    expect(spec('openclaw').skills?.inject).toEqual({
      kind: 'config',
      jsonPath: ['skills', 'load', 'extraDirs'],
    });
  });

  it("opencode's run env names the box-local library and keeps its declared env", () => {
    const env = agentRunEnv(spec('opencode'));
    expect(JSON.parse(env['OPENCODE_CONFIG_CONTENT']!)).toEqual({
      skills: { paths: [BOX_SKILLS_LIBRARY_DIR] },
    });
    expect(env['OPENCODE_CONFIG_DIR']).toBe(spec('opencode').boxRunEnv['OPENCODE_CONFIG_DIR']);
    // No env injection: the declared env, unchanged.
    expect(agentRunEnv(spec('claude'))).toEqual(spec('claude').boxRunEnv);
  });

  it("pi's launch adds --skill <library> after its declared flags", () => {
    expect(agentLaunchFlags(spec('pi'))).toEqual([
      ...(spec('pi').launchFlags ?? []),
      '--skill',
      BOX_SKILLS_LIBRARY_DIR,
    ]);
    expect(agentLaunchFlags(spec('codex'))).toEqual(spec('codex').launchFlags);
  });

  it("openclaw's boot task merges the library dir next to AgentBox's own skills dir", () => {
    const task = spec('openclaw').service?.tasks?.find((t) => t.name === 'openclaw-agentbox-env');
    expect(task?.command).toContain(`/opt/agentbox/skills:${BOX_SKILLS_LIBRARY_DIR}`);
    expect(OPENCLAW_CONFIG_MERGE_PROGRAM).toContain(".split(':')");
  });
});
