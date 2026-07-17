/**
 * Resolving a user's box ref against the control box's registry.
 *
 * Lives in its own module because BOTH `hub-adopt` and `hub-pull` must resolve
 * a ref identically — they key different things off the result (a `BoxRecord`
 * vs. the custody `boxes/<key>/ssh` subtree), so a matcher that drifts between
 * them writes one box's keys under another box's id.
 */
import type { BoxRegistration } from '@agentbox/relay';

/**
 * Resolve a ref using the SAME rules the local resolver uses (`findBox`): exact
 * id / name / sandbox id, then a UNIQUE id-or-sandbox-id prefix. Without the
 * prefix arm, a shortened ref that works for a local box mysteriously fails for
 * a hub-only one.
 *
 * An ambiguous prefix resolves to nothing rather than picking one: callers write
 * state and then drive the box, so guessing wrong is worse than not matching.
 */
export function matchRegistration(
  regs: BoxRegistration[],
  ref: string,
): BoxRegistration | undefined {
  const exact = regs.find((r) => r.boxId === ref || r.name === ref || r.sandboxId === ref);
  if (exact) return exact;
  const byPrefix = regs.filter(
    (r) => r.boxId.startsWith(ref) || r.sandboxId?.startsWith(ref) === true,
  );
  return byPrefix.length === 1 ? byPrefix[0] : undefined;
}
