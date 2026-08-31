/**
 * The built-in agents, aggregated from the packages that own them.
 *
 * WHY THIS PACKAGE EXISTS. `sandbox-core` is depended on by every provider, the
 * relay and the hub, so it can never import an agent package — an agent's
 * behavior depends on `sandbox-core` in turn. But the agent DATA has to be
 * readable from down there, and synchronously: the relay answers `agents.list`
 * from it, the hub reads it to report what a host carries, and `sandbox-core`
 * itself drives seeding and staging off it.
 *
 * So the data is imported from each agent's `./spec` entry — the one that
 * depends on nothing but the two leaves — and this package sits BELOW
 * `sandbox-core` in the graph. The agent packages' main entries, which hold the
 * behavior, sit above it and are loaded lazily by the CLI. Same shape the
 * providers use: `PROVIDERS` is data in a leaf, `sandbox-<name>` is code loaded
 * from a literal-import table.
 *
 * The import specifiers are LITERAL, for the reason `provider/loaders.ts`
 * documents: the CLI's tsup inlines `@agentbox/*`, which needs esbuild to
 * resolve each one statically. A computed specifier would `MODULE_NOT_FOUND` in
 * the published CLI and never in the dev tree.
 */

import { claudeSpec } from '@agentbox/agent-claude/spec';
import { codexSpec } from '@agentbox/agent-codex/spec';
import { opencodeSpec } from '@agentbox/agent-opencode/spec';
import type { AgentId, AgentSyncSpec } from '@agentbox/core';

/**
 * Canonical order — claude first, matching the order these rows had when they
 * lived in one table. `list`, the dashboard and the pickers all present agents
 * in this order, so it is a user-visible fact, not an implementation detail.
 */
export const AGENT_SPECS: readonly AgentSyncSpec[] = [claudeSpec, codexSpec, opencodeSpec];

/** Every built-in agent id, in canonical order. */
export function builtinAgentIds(): AgentId[] {
  return AGENT_SPECS.map((s) => s.id);
}

/**
 * The spec for `id`, or undefined. Resolves aliases (`claude-code` -> claude),
 * because persisted queue jobs and box records still carry the wire spelling.
 */
export function findAgentSpec(id: string): AgentSyncSpec | undefined {
  return AGENT_SPECS.find((s) => s.id === id || s.aliases.includes(id));
}
