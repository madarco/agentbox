import { describe, expect, it } from 'vitest';
import { buildPromptArgs } from '../src/lib/queue/build-prompt-args.js';

describe('buildPromptArgs', () => {
  it('slots the prompt as the first positional for claude', () => {
    expect(buildPromptArgs('claude-code', 'hello', ['--model', 'sonnet'])).toEqual([
      'hello',
      '--model',
      'sonnet',
    ]);
  });

  // Checked against each CLI's --help: `codex [PROMPT]`, `pi [messages...]`.
  it('slots the prompt as the first positional for codex and pi', () => {
    expect(buildPromptArgs('codex', 'do it', ['-m', 'gpt-5.4'])).toEqual([
      'do it',
      '-m',
      'gpt-5.4',
    ]);
    expect(buildPromptArgs('pi', 'go', ['--model', 'x'])).toEqual(['go', '--model', 'x']);
  });

  // opencode's positional is `[project]`: a positional prompt made it `cd` into
  // `/workspace/<prompt>` and exit.
  it('puts the prompt behind --prompt for opencode', () => {
    expect(buildPromptArgs('opencode', 'say hi', ['--model', 'openai/gpt-5'])).toEqual([
      '--prompt',
      'say hi',
      '--model',
      'openai/gpt-5',
    ]);
    expect(buildPromptArgs('opencode', '', ['--model', 'm'])).toEqual(['--model', 'm']);
  });

  it('falls back to a positional for an agent the registry does not know', () => {
    expect(buildPromptArgs('not-an-agent', 'hi', [])).toEqual(['hi']);
  });

  it('is a no-op when prompt is empty (user args returned verbatim)', () => {
    expect(buildPromptArgs('claude-code', '', ['--model', 'sonnet'])).toEqual([
      '--model',
      'sonnet',
    ]);
  });

  it('does not mutate the user args list', () => {
    const userArgs = ['--model', 'sonnet'];
    const out = buildPromptArgs('claude-code', 'hi', userArgs);
    expect(userArgs).toEqual(['--model', 'sonnet']);
    expect(out).not.toBe(userArgs);
  });
});
