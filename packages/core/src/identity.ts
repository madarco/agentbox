import { randomBytes } from 'node:crypto';

/**
 * Stable identity helpers shared across providers. Currently just the per-box
 * id mint; checkpoint ids etc. can join later under their own prefix.
 */

/**
 * Type tag prefixed to every minted box id so the kind is readable at a glance
 * and id namespaces can grow without colliding (reserve `c` for checkpoints,
 * etc.). The leading non-digit is load-bearing: it guarantees a box id is never
 * an all-decimal string, which would otherwise collide with the per-project
 * numeric index in `resolveBoxRef` (`agentbox open 4`) and make all-digit ids
 * unresolvable.
 */
export const BOX_ID_PREFIX = 'b';

export function generateBoxId(): string {
  return `${BOX_ID_PREFIX}${randomBytes(4).toString('hex')}`;
}
