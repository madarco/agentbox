/**
 * Core sync vocabulary — the topology-neutral types the sync layer is built
 * around. Kept in `@agentbox/core` (zero runtime deps) so every package that
 * touches sync — the two providers, the relay (host), and `ctl` (in-box) —
 * shares one vocabulary without a dependency cycle.
 *
 * The *implementation* (registry, concern modules, driver, transports) lives in
 * `@agentbox/sandbox-core`'s `sync/` folder and the two provider packages; only
 * the contracts live here.
 */

/** Which way bytes/refs flow in one reconcile step. */
export type SyncDirection = 'push' | 'pull' | 'reconcile';

/**
 * The three federation shapes a box can be in. Resolved ONCE per box (from the
 * provider name + whether a control-plane URL is configured) and consumed by
 * every concern to pick the matching transport.
 *
 * - `docker`        — local Docker box; bind-mounted `.git`, host relay loopback.
 * - `cloud`         — cloud box seeded/synced host-side via the backend SDK.
 * - `control-plane` — cloud box whose live relay is a hosted control plane; git
 *                     push-back leases a GitHub-App token and pushes directly.
 */
export type SyncTopology = 'docker' | 'cloud' | 'control-plane';

/**
 * The three parties in a reconcile. For the git/content triangle `remote` is the
 * GitHub remote; for the registry/state triangle it is the hosted control plane.
 */
export type SyncParty = 'host' | 'box' | 'remote';

/** One thing being synced. Each maps to a concern module under `sync/concerns/`. */
export type SyncConcern =
  | 'git'
  | 'workspace'
  | 'env'
  | 'files'
  | 'credentials'
  | 'skills'
  | 'dynamic'
  | 'registry';

/**
 * Reserved sync-reconciliation state for a future real 3-way merge (common
 * base, last-synced pointers, per-party version vectors). Nothing writes this
 * today — box-wins reconciliation is stateless — but the shape is fixed now so
 * the relay `Store` can gain optional `getSyncState?`/`putSyncState?` methods
 * later without a contract change. Do NOT build a consumer for this yet.
 */
export interface SyncState {
  /** Ref both sides last agreed on (the merge base for a future 3-way policy). */
  baseRef?: string;
  /** ISO-8601 timestamp of the last successful reconcile. */
  lastSyncedAt?: string;
  /** Per-party content marker (hash/ref) at last sync. */
  vector?: Partial<Record<SyncParty, string>>;
}
