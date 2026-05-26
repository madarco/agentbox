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

  it('slots the prompt as the first positional for codex and opencode', () => {
    expect(buildPromptArgs('codex', 'do it', ['-m', 'gpt-5.4'])).toEqual(['do it', '-m', 'gpt-5.4']);
    expect(buildPromptArgs('opencode', 'go', [])).toEqual(['go']);
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
