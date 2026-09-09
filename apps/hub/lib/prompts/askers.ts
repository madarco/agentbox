/**
 * The hub's two {@link PromptAsker}s.
 *
 * Together they turn a gate into a two-step HTTP conversation without the gate
 * knowing: run it once with {@link collectAsker} to learn what it would ask
 * (that IS the preflight — there is no second "what would I ask?" code path to
 * drift from the real one), then run it again with {@link answerMapAsker} once
 * the client has posted answers back.
 */

import type { PromptAnswer, PromptAsker, PromptRequest } from '@agentbox/core';

export interface CollectingAsker {
  ask: PromptAsker;
  /** Every question the gate reached, in the order it asked. */
  collected: PromptRequest[];
}

/**
 * Record each question and answer it with its own fallback, so the gate runs to
 * completion and the caller ends up holding the full question list.
 *
 * The gate's side effects are all reads (resolve + stat), so running it for its
 * questions costs nothing beyond the walk it would do anyway.
 */
export function collectAsker(): CollectingAsker {
  const collected: PromptRequest[] = [];
  return {
    collected,
    ask: (req) => {
      collected.push(req);
      return Promise.resolve({ id: req.id, value: req.fallback.value });
    },
  };
}

/** A prompt the client had to answer and didn't. */
export class UnansweredPromptError extends Error {
  constructor(public readonly request: PromptRequest) {
    super(
      `${request.topic}: this create needs an answer to "${request.title}" and none was supplied` +
        (request.nonInteractiveHint ? `. ${request.nonInteractiveHint}` : ''),
    );
    this.name = 'UnansweredPromptError';
  }
}

/**
 * Replay the answers a client collected during its preflight.
 *
 * A missing answer is only fatal for a `required` prompt: those are the ones
 * whose silent resolution would move host secrets. Everything else falls back,
 * which is what lets an older client that knows nothing about a newly added
 * prompt still create a box.
 *
 * An answer whose id does not match is treated as absent rather than applied.
 * Ids are content-addressed, so a mismatch means the question changed between
 * the preflight and the create — `agentbox.yaml` was edited, or a host login
 * appeared or expired — and answering the new question with the old answer is
 * exactly the mistake worth refusing.
 */
export function answerMapAsker(answers: readonly PromptAnswer[] | undefined): PromptAsker {
  const byId = new Map((answers ?? []).map((a) => [a.id, a]));
  return (req) => {
    const hit = byId.get(req.id);
    if (hit) return Promise.resolve(hit);
    if (req.required) throw new UnansweredPromptError(req);
    return Promise.resolve({ id: req.id, value: req.fallback.value });
  };
}
