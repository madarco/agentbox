/**
 * The agent registry — now a thin view over `@agentbox/agent-registry`.
 *
 * The rows used to be a literal table here. They live in the agent packages
 * themselves (`@agentbox/agent-<id>/spec`), which the aggregator imports and
 * this module re-exports, so the ~40 call sites that reach for
 * `AGENT_SYNC_SPECS` / `resolveAgentSpec` through `@agentbox/sandbox-core` keep
 * working unchanged.
 *
 * The direction matters: `sandbox-core` depends on the aggregator, never on an
 * agent's behavior. An agent package's main entry depends on `sandbox-core` in
 * turn, and only the CLI — at the top of the graph — pulls that in. Exactly the
 * provider split, where the data is a table in a leaf and the code is a package
 * loaded from a literal-import map.
 */

import { AGENT_SPECS } from '@agentbox/agent-registry';
import type { AgentId, AgentSyncSpec } from '@agentbox/core';

export const AGENT_SYNC_SPECS: readonly AgentSyncSpec[] = AGENT_SPECS;

/** Resolve a spec by canonical id or any alias (e.g. `'claude-code'` → the claude spec). */
export function resolveAgentSpec(name: string): AgentSyncSpec {
  const spec = AGENT_SYNC_SPECS.find((s) => s.id === name || s.aliases.includes(name));
  if (!spec) throw new Error(`no agent sync spec for '${name}'`);
  return spec;
}

/** The canonical ids, in registry order. */
export function agentIds(): AgentId[] {
  return AGENT_SYNC_SPECS.map((s) => s.id);
}

/**
 * True for any agent this build knows about, by canonical id or alias.
 *
 * The open counterpart to `isAgentKind` in `@agentbox/core`: that one answers
 * from a hardcoded list because a dependency-free leaf has no registry to ask,
 * this one answers from the registry. Same split as `isProviderKind`
 * (`@agentbox/config`) vs `isRuntimeProvider` (the CLI's provider loaders), and
 * the same reason — the registry is the authority, but not everyone can reach it.
 */
export function isRuntimeAgent(name: string): boolean {
  return AGENT_SYNC_SPECS.some((s) => s.id === name || s.aliases.includes(name));
}

/**
 * The env that pins `binary`'s in-box terminal renderer for `mode`.
 *
 * The generic counterpart of `agentLaunchFlags`: reads `AgentSyncSpec.tuiEnv`,
 * and answers `{}` for an agent that declares none. Replaces the
 * `binary === 'claude'` branches the cloud launch sites used to carry — claude
 * is still the only agent with an entry, but that is now a fact about the
 * registry rather than about the code.
 *
 * Guarded on `isRuntimeAgent`, like `agentLaunchFlags`: the binary here is an
 * open string and an unknown one must not throw.
 */
export function agentTuiEnv(binary: string, mode: string): Record<string, string> {
  if (!isRuntimeAgent(binary)) return {};
  return { ...(resolveAgentSpec(binary).tuiEnv?.[mode] ?? {}) };
}
