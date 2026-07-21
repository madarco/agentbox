/**
 * The single adapter reconciling the two spellings of the Claude agent across
 * the codebase:
 *  - `'claude'`      — canonical INTERNAL name (sync layer, docker volumes,
 *    `BoxRecord.lastAgent`, the CLI `claude` subcommand).
 *  - `'claude-code'` — the FROZEN wire/registry name (relay `QueueAgentKind`,
 *    persisted queue jobs, the `AgentLauncher` registry).
 *
 * Everything downstream of a boundary uses the canonical `SyncAgentKind`;
 * `toQueueKind` / `toSyncKind` translate only at the boundary. We NEVER rewrite
 * persisted wire/record values — back-compat is read-time normalization
 * (`normalizeLastAgent`), so existing box records and in-flight queue jobs keep
 * working untouched.
 */

/** Canonical internal agent id. */
export type SyncAgentKind = 'claude' | 'codex' | 'opencode';

/** The frozen wire/queue spelling (relay `QueueAgentKind`, persisted jobs). */
export type QueueAgentKind = 'claude-code' | 'codex' | 'opencode';

export const SYNC_AGENT_KINDS: readonly SyncAgentKind[] = ['claude', 'codex', 'opencode'];

/** True for a known canonical id. */
export function isSyncAgentKind(v: unknown): v is SyncAgentKind {
  return v === 'claude' || v === 'codex' || v === 'opencode';
}

/**
 * Boundary → internal. Maps the wire spelling `'claude-code'` to `'claude'`;
 * `'codex'`/`'opencode'` pass through. Throws on anything else so a typo can't
 * silently seed the wrong agent.
 */
export function toSyncKind(k: string): SyncAgentKind {
  if (k === 'claude-code' || k === 'claude') return 'claude';
  if (k === 'codex') return 'codex';
  if (k === 'opencode') return 'opencode';
  throw new Error(`unknown agent kind: ${k}`);
}

/** Internal → boundary. Maps `'claude'` to the wire spelling `'claude-code'`. */
export function toQueueKind(k: SyncAgentKind): QueueAgentKind {
  return k === 'claude' ? 'claude-code' : k;
}

/**
 * Read-time back-compat for persisted `BoxRecord.lastAgent`. A record written by
 * any past/forked build that stored `'claude-code'` still resolves to
 * `'claude'`; unknown/absent values return undefined rather than throwing (a
 * stale record must never crash `list`/`recover`).
 */
export function normalizeLastAgent(raw: string | undefined | null): SyncAgentKind | undefined {
  if (!raw) return undefined;
  if (raw === 'claude-code' || raw === 'claude') return 'claude';
  if (raw === 'codex') return 'codex';
  if (raw === 'opencode') return 'opencode';
  return undefined;
}
