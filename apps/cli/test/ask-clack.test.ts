import { describe, expect, it } from 'vitest';
import type { PromptRequest } from '@agentbox/core';
import { clackAsker } from '../src/lib/ask-clack.js';

/**
 * Only the NON-TTY half is testable without a PTY, and it is the half worth
 * pinning: it is what decides whether a scripted create silently gains or
 * loses a credential. (The interactive multiselect is driven through
 * `pnpm drive`.)
 */
const base: PromptRequest = {
  id: 'model-auth:abc',
  topic: 'model-auth',
  kind: 'select',
  title: 'Which of these should this box be able to use?',
  choices: [
    { value: 'codex', label: 'Your Codex login' },
    { value: 'claude', label: 'Your Claude login' },
    { value: 'none', label: 'None of these', exclusive: true },
  ],
  fallback: { value: 'none', reason: 'not asked' },
};

describe('clackAsker without a TTY', () => {
  it('takes the fallback for a multiple select, exactly as for a single one', async () => {
    // `multiple` adds NO non-interactive branch: one fallback value is always a
    // valid multi answer, because n=1 encodes to the bare value.
    const ask = clackAsker({ isTTY: false });
    expect(await ask({ ...base, multiple: true })).toEqual({ id: base.id, value: 'none' });
    expect(await ask(base)).toEqual({ id: base.id, value: 'none' });
  });

  it('carries a multi-valued fallback through untouched', async () => {
    const ask = clackAsker({ isTTY: false });
    const req = { ...base, multiple: true, fallback: { value: 'codex,claude', reason: 'r' } };
    expect((await ask(req)).value).toBe('codex,claude');
  });

  it('refuses a required prompt with the gate`s own hint', async () => {
    const ask = clackAsker({ isTTY: false });
    await expect(
      ask({ ...base, required: true, nonInteractiveHint: 'Set AGENTBOX_X=1.' }),
    ).rejects.toThrow(/Set AGENTBOX_X=1\./);
  });

  it('says out loud which fallback it took', async () => {
    const lines: string[] = [];
    await clackAsker({ isTTY: false, onLog: (l) => lines.push(l) })(base);
    expect(lines).toEqual(['model-auth: not asked']);
  });
});
