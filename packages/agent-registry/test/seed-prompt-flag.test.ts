import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENT_SPECS } from '../src/index.js';
import { agentSpecProblem } from '../src/plugin-agents.js';
import { exampleSpec } from '../src/specs/example.js';

describe('seedPromptFlag', () => {
  const flag = (id: string) => BUILTIN_AGENT_SPECS.find((s) => s.id === id)?.seedPromptFlag;

  it('opencode takes its seed prompt behind --prompt; claude, codex and pi take a positional', () => {
    expect(flag('opencode')).toBe('--prompt');
    expect(flag('claude')).toBeUndefined();
    expect(flag('codex')).toBeUndefined();
    expect(flag('pi')).toBeUndefined();
  });

  it('a plugin spec may declare one flag token, nothing else', () => {
    expect(agentSpecProblem({ ...exampleSpec, seedPromptFlag: '--prompt' })).toBeNull();
    expect(agentSpecProblem({ ...exampleSpec, seedPromptFlag: '-p' })).toBeNull();
    for (const bad of ['prompt', '--prompt x', '', '--', 3]) {
      expect(agentSpecProblem({ ...exampleSpec, seedPromptFlag: bad }), String(bad)).toMatch(
        /seedPromptFlag/,
      );
    }
  });
});
