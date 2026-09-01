/**
 * The one agent-id type, and the adapter reconciling the two spellings of the
 * Claude agent across the codebase:
 *  - `'claude'`      — canonical INTERNAL name (sync layer, docker volumes,
 *    `BoxRecord.lastAgent`, the CLI `claude` subcommand).
 *  - `'claude-code'` — the FROZEN wire/registry name (persisted queue jobs, the
 *    `AgentLauncher` registry).
 *
 * Everything downstream of a boundary uses `AgentId`; `toQueueKind` /
 * `toSyncKind` translate only at the boundary. We NEVER rewrite persisted
 * wire/record values — back-compat is read-time normalization
 * (`normalizeLastAgent`), so existing box records and in-flight queue jobs keep
 * working untouched.
 *
 * WHY THIS LIVES IN `@agentbox/core`: it is the only package with no internal
 * dependencies, so it is the one place `sandbox-*`, `relay`, `ctl`, the hub and
 * the CLI can all reach. The agent REGISTRY (`AGENT_SYNC_SPECS`) deliberately
 * stays in `@agentbox/sandbox-core` — it carries host paths and install recipes
 * that have no business in a type contract, and `ctl` (baked into the box image)
 * must never import it.
 *
 * WHY `AgentId` IS `string` AND NOT A UNION: an agent is data — a registry row —
 * so the set of valid ids is a runtime fact, not a compile-time one. The cost is
 * that the compiler no longer enumerates the sites a newly-added agent misses,
 * which is why that job is done by tests instead: `no-inline-agent-union.test.ts`
 * fails if a hardcoded union of the shipped agent names reappears anywhere in
 * src, and the per-surface tables assert their keys against `agentIds()`.
 * Removing either guard silently re-closes the type.
 */

/**
 * Canonical internal agent id. Open by design (see the file doc); validate with
 * {@link isAgentKind} for the built-ins or `isRuntimeAgent` from
 * `@agentbox/sandbox-core` for anything the registry knows about.
 */
export type AgentId = string;

/** The frozen wire/queue spelling (persisted jobs, `AgentLauncher.kind`). */
export type QueueAgentKind = string;

/**
 * An agent id, or the plain shell — what a box's terminal is currently showing.
 * Distinct from {@link AgentId} because `'shell'` is a UI mode, not an agent: it
 * has no registry row, no credentials and no install recipe.
 */
export type AgentMode = AgentId | 'shell';

/**
 * The agents compiled into this build. NOT the authority on what exists — the
 * registry is (`agentIds()` / `isRuntimeAgent` in `@agentbox/sandbox-core`).
 * This list exists only for the two things a dependency-free leaf can still do
 * honestly: normalize a persisted record and translate a wire spelling.
 */
export const BUILTIN_AGENT_KINDS: readonly AgentId[] = ['claude', 'codex', 'opencode', 'pi'];

/** Wire spellings that map onto a different canonical id. */
const WIRE_ALIASES: Readonly<Record<string, AgentId>> = { 'claude-code': 'claude' };

/** Canonical ids whose wire spelling differs, keyed the other way. */
const WIRE_SPELLINGS: Readonly<Record<AgentId, QueueAgentKind>> = { claude: 'claude-code' };

/** True for an agent built into this release. */
export function isAgentKind(v: unknown): v is AgentId {
  return typeof v === 'string' && BUILTIN_AGENT_KINDS.includes(v);
}

/**
 * Boundary → internal. Maps the wire spelling `'claude-code'` to `'claude'`;
 * every other known id passes through. Throws on anything else so a typo can't
 * silently seed the wrong agent — with `AgentId` open this is the only
 * validation left at this boundary, so it stays fail-closed.
 */
export function toSyncKind(k: string): AgentId {
  const canonical = WIRE_ALIASES[k] ?? k;
  if (!isAgentKind(canonical)) throw new Error(`unknown agent kind: ${k}`);
  return canonical;
}

/** Internal → boundary. Maps `'claude'` to the wire spelling `'claude-code'`. */
export function toQueueKind(k: AgentId): QueueAgentKind {
  return WIRE_SPELLINGS[k] ?? k;
}

/**
 * Read-time back-compat for persisted `BoxRecord.lastAgent`. A record written by
 * any past/forked build that stored `'claude-code'` still resolves to
 * `'claude'`; unknown/absent values return undefined rather than throwing (a
 * stale record must never crash `list`/`recover`).
 */
export function normalizeLastAgent(raw: string | undefined | null): AgentId | undefined {
  if (!raw) return undefined;
  const canonical = WIRE_ALIASES[raw] ?? raw;
  return isAgentKind(canonical) ? canonical : undefined;
}
