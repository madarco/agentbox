import { describe, expect, it } from 'vitest';
import type { PromptRequest } from '@agentbox/core';
import { answerMapAsker, collectAsker, UnansweredPromptError } from '../lib/prompts/askers';

/**
 * The two askers that turn a gate into a two-step HTTP conversation. Pure: no
 * filesystem, no backend.
 */
const REQUIRED: PromptRequest = {
  id: 'carry:abc123',
  topic: 'carry',
  kind: 'select',
  title: 'Copy 2 host entries into the box?',
  fallback: { value: 'cancel', reason: 'nobody could approve the copy' },
  required: true,
  nonInteractiveHint: 'Set AGENTBOX_CARRY_YES=1 to opt in.',
};

const OPTIONAL: PromptRequest = {
  id: 'model-auth:def456',
  topic: 'model-auth',
  kind: 'select',
  title: 'Seed this openclaw box with a model provider login?',
  fallback: { value: 'none', reason: 'not asked' },
};

describe('collectAsker', () => {
  it('records the question and answers it with its own fallback', async () => {
    const { ask, collected } = collectAsker();
    expect(await ask(REQUIRED)).toEqual({ id: REQUIRED.id, value: 'cancel' });
    expect(await ask(OPTIONAL)).toEqual({ id: OPTIONAL.id, value: 'none' });
    // Answering with the fallback is what lets the gate run to completion, so
    // one pass yields every question it would have asked.
    expect(collected.map((p) => p.topic)).toEqual(['carry', 'model-auth']);
  });
});

describe('answerMapAsker', () => {
  it('replays a matching answer', async () => {
    const ask = answerMapAsker([{ id: REQUIRED.id, value: 'approve' }]);
    expect(await ask(REQUIRED)).toEqual({ id: REQUIRED.id, value: 'approve' });
  });

  it('falls back for an unanswered optional prompt', async () => {
    expect(await answerMapAsker([])(OPTIONAL)).toEqual({ id: OPTIONAL.id, value: 'none' });
    // An older client that knows nothing about a newly added prompt must still
    // be able to create a box.
    expect(await answerMapAsker(undefined)(OPTIONAL)).toEqual({ id: OPTIONAL.id, value: 'none' });
  });

  it('refuses an unanswered required prompt, naming the escape hatch', () => {
    expect(() => answerMapAsker([])(REQUIRED)).toThrow(UnansweredPromptError);
    expect(() => answerMapAsker([])(REQUIRED)).toThrow(/AGENTBOX_CARRY_YES=1/);
  });

  it('treats a stale id as no answer at all', () => {
    // The question changed between the preflight and the create (agentbox.yaml
    // was edited), so the old answer names a different question. Applying it is
    // exactly the mistake the content-addressed id exists to prevent.
    const ask = answerMapAsker([{ id: 'carry:staleaaa', value: 'approve' }]);
    expect(() => ask(REQUIRED)).toThrow(UnansweredPromptError);
  });
});
