/**
 * The create request a staged restore turns into — the second half of
 * `POST /api/v1/projects/:id/restore`.
 *
 * Sibling of `cloneCreateInput`, and pure for the same reason: what makes a
 * restore a restore rather than an ordinary create is *which create it asks
 * for*, and a Next route handler is not reachable from a unit test.
 *
 * The difference from a clone is the whole point of the feature. A clone
 * deliberately drops the identity — a second bot onboards its own. A restore
 * must bring it back, so the create carries `restore`, which the queue worker
 * consumes AFTER the box's service has come up on its own.
 */
import type { CreateBoxInput, PrepareRestoreResult } from './backend-types';

/** The `prepareRestore` fields this builder reads. */
export type StagedRestore = Extract<PrepareRestoreResult, { ok: true }>;

export function restoreCreateInput(prepared: StagedRestore): CreateBoxInput {
  return {
    projectId: prepared.projectId,
    provider: prepared.provider,
    // Unlike a clone, the agent is not optional: a restore exists to put an
    // identity back, and there is nothing to put it into without the agent that
    // owns it. `prepareRestore` refuses a bundle whose agent it cannot resolve,
    // so this is always the bundle's own.
    agent: prepared.agent ?? 'none',
    name: prepared.name,
    // FOREGROUND, for the same reason a clone is: one caller-initiated action
    // whose caller is blocked on the job stream this route hands back.
    foreground: true,
    opts: {
      ...(prepared.persistent !== undefined ? { persistent: prepared.persistent } : {}),
      // The state half. The worker waits for the service, stops it, pushes this
      // bundle's `state/` in, and restarts — the ordering openclaw's run-once
      // onboard marker forces, since the marker lives on the box rootfs and
      // fires on every fresh box no matter what the config volume holds.
      restore: { bundleDir: prepared.bundleDir, agent: prepared.agent },
      // Same inheritance rule as a clone: no human is here to answer a
      // `required` carry prompt, and the bundle's own box was approved for this
      // project's block.
      carryYes: true,
    },
  };
}
