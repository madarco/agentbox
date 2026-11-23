import { describe, expect, it } from 'vitest';
import { resolveAgentLauncher } from '../src/agent.js';

describe('resolveAgentLauncher', () => {
  it('seeds a leading positional when the spec declares no flag', () => {
    expect(resolveAgentLauncher('codex').buildArgs('hi', ['-m', 'x'])).toEqual(['hi', '-m', 'x']);
    expect(resolveAgentLauncher('pi', {}).buildArgs('hi', [])).toEqual(['hi']);
  });

  it('puts the prompt behind the declared seedPromptFlag', () => {
    const l = resolveAgentLauncher('opencode', { seedPromptFlag: '--prompt' });
    expect(l.buildArgs('say hi', ['--model', 'm'])).toEqual(['--prompt=say hi', '--model', 'm']);
  });

  // As a separate token, yargs reads a leading-dash prompt as flags and drops it.
  it('keeps a prompt that starts with a dash attached to a long flag', () => {
    const l = resolveAgentLauncher('opencode', { seedPromptFlag: '--prompt' });
    expect(l.buildArgs('-fix the bug', [])).toEqual(['--prompt=-fix the bug']);
  });

  it('passes a short flag and the prompt as two tokens', () => {
    const l = resolveAgentLauncher('x', { seedPromptFlag: '-p' });
    expect(l.buildArgs('hi', [])).toEqual(['-p', 'hi']);
  });

  it('returns the user args untouched for an empty prompt', () => {
    const l = resolveAgentLauncher('opencode', { seedPromptFlag: '--prompt' });
    const userArgs = ['--model', 'm'];
    const out = l.buildArgs('', userArgs);
    expect(out).toEqual(['--model', 'm']);
    expect(out).not.toBe(userArgs);
  });
});
