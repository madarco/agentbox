/**
 * Reconciler + conflict-policy contracts — the extension seam for bidirectional
 * / 3-way sync. Today there is exactly one policy (box-wins content-hash, the
 * current docker resync behavior) and the workspace reconciler; these
 * interfaces exist so a future `ThreeWayBasePolicy` or a new concern's
 * reconciler plugs in without touching the merge orchestration.
 *
 * Do NOT over-build against these — ship one implementation each.
 */

import type { SyncConcern, SyncDirection, SyncTopology } from './types.js';

/**
 * How one conflicting item is resolved. `take-a`/`take-b` pick a side (the
 * current resync uses these — box wins ⇒ keep the box's version); `both` keeps
 * both; `mark` leaves a conflict marker (reserved for a future 3-way policy —
 * the current box-wins policy never emits it).
 */
export type ConflictVerdict = 'take-a' | 'take-b' | 'both' | 'mark';

export interface ConflictPolicy<Item = unknown> {
  /** Stable name for logging/telemetry, e.g. `'box-wins-content-hash'`. */
  readonly name: string;
  resolve(item: Item): ConflictVerdict;
}

/**
 * One concern's reconcile behavior across the three topologies. A concern that
 * only pushes (env, files) implements `supports` narrowly; the git/workspace
 * concern implements all three directions.
 */
export interface Reconciler<Plan = unknown, Result = unknown> {
  readonly concern: SyncConcern;
  supports(direction: SyncDirection, topology: SyncTopology): boolean;
  reconcile(direction: SyncDirection, plan: Plan): Promise<Result>;
}
