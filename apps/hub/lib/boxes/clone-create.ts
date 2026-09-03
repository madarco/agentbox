/**
 * The create request a staged clone turns into — the second half of
 * `POST /api/v1/boxes/:id/clone`.
 *
 * Pure and separate from the route for the same reason `controlPlaneCreateRequest`
 * is: the interesting part of that route is *which create* it asks for, and a
 * Next route handler is not reachable from a unit test (no `@/` alias at test
 * runtime). Keeping the decision here means the two things that are easy to drop
 * silently — the foreground lane and the resolved `persistent` — are asserted.
 */
import type { CreateBoxInput, PrepareCloneResult } from './backend-types';

/** The `prepareClone` fields this builder reads. */
export type StagedClone = Extract<PrepareCloneResult, { ok: true }>;

export function cloneCreateInput(prepared: StagedClone): CreateBoxInput {
  return {
    projectId: prepared.projectId,
    provider: prepared.provider,
    // A clone carries the workspace files, never the agent's config volume or
    // credential — the new box onboards fresh. Nothing to start, so no agent.
    agent: 'none',
    name: prepared.name,
    // FOREGROUND, always. A clone is one caller-initiated action whose caller is
    // blocked on the job stream this route hands back, so it belongs in the
    // ungated lane — exactly where the CLI put it before the create moved behind
    // the API. Without it a clone queues behind background `-i` jobs and can sit
    // there indefinitely while the user watches a spinner.
    foreground: true,
    // Only when the hub HAS an opinion: `prepareClone` returns undefined when
    // neither the request nor the source box said anything, and sending `false`
    // there would override the hub's own `box.persistent`.
    ...(prepared.persistent !== undefined ? { opts: { persistent: prepared.persistent } } : {}),
  };
}
