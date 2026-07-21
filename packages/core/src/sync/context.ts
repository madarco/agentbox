/**
 * `SyncContext` — the runtime values a sync concern needs that aren't the
 * transport or its per-call plan. Assembled once by the provider (docker/cloud)
 * at create or session-start and threaded through every concern (and the
 * `ProviderSync` facade), so concern/facade signatures stay `(ctx, …opArgs)`.
 *
 * This is a Tier-1 contract (pure data — no fs/exec), so both the `ProviderSync`
 * interface here in `@agentbox/core` and the concern implementations in
 * `@agentbox/sandbox-core` can name it. The builder `makeSyncContext` (which
 * defaults `hostHome` to the OS home dir) lives in `@agentbox/sandbox-core`.
 */
export interface SyncContext {
  /** Friendly box name (`agentbox/<name>` branch, tmux session, logs). */
  boxName: string;
  /** Stable box id. */
  boxId: string;
  /** Which provider assembled this context. */
  provider: 'docker' | 'cloud';
  /** Absolute host workspace dir mounted at `boxWorkspace`. */
  hostWorkspace: string;
  /** Project root (nearest `agentbox.yaml` ancestor, else `hostWorkspace`). */
  projectRoot: string;
  /** In-box workspace mount. Always `/workspace` today; overridable for tests. */
  boxWorkspace: string;
  /** Host home dir (source of `~/.claude` etc.). Overridable for tests. */
  hostHome: string;
  onLog: (line: string) => void;
}
