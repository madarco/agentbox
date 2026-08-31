/**
 * The built-in agent specs.
 *
 * WHY A PACKAGE OF ITS OWN, BELOW `sandbox-core`. Every provider, the relay and
 * the hub depend on `sandbox-core`, and all three need agent DATA synchronously:
 * the relay answers `agents.list` from it, the hub reports what a host carries,
 * `sandbox-core` drives seeding and staging off it. So the data has to sit below
 * all of them.
 *
 * WHY THE DATA IS NOT IN THE AGENT PACKAGES. It was, briefly, behind a `./spec`
 * subpath with leaf-only dependencies — the theory being that entry points would
 * keep the graph acyclic. They do not: pnpm and turbo resolve per PACKAGE, so the
 * moment an agent package gains behavior (and therefore depends on
 * `sandbox-docker`) turbo refuses to build:
 *
 *   Circular package dependency detected: @agentbox/agent-example,
 *     @agentbox/agent-registry, @agentbox/sandbox-core, @agentbox/relay,
 *     @agentbox/ctl, @agentbox/sandbox-docker
 *
 * Data and behavior therefore live in separate packages — exactly the provider
 * split, where `PROVIDERS` is a table in a leaf and `sandbox-<name>` is code
 * loaded from a literal-import map.
 *
 * THIS COSTS COMMUNITY AGENTS NOTHING. A plugin agent lives in the user's
 * `node_modules`, is loaded through a variable `import()`, and never enters the
 * workspace graph — structurally exempt from the cycle. It ships its descriptor
 * inside its own package and `agent add` snapshots it, the way `plugin add`
 * already does for providers. This table is only the shortcut for the agents
 * compiled into the CLI.
 */

import { claudeSpec } from './specs/claude.js';
import { codexSpec } from './specs/codex.js';
import { exampleSpec } from './specs/example.js';
import { opencodeSpec } from './specs/opencode.js';
import type { AgentId, AgentSyncSpec } from '@agentbox/core';

/**
 * Canonical order — claude first, matching the order these rows had when they
 * lived in one table. `list`, the dashboard and the pickers all present agents
 * in this order, so it is a user-visible fact, not an implementation detail.
 */
export const AGENT_SPECS: readonly AgentSyncSpec[] = [
  claudeSpec,
  codexSpec,
  opencodeSpec,
  exampleSpec,
];

/**
 * The agents a user should be offered — pickers, `--help`, the install wizard,
 * the `--agents` bake list.
 *
 * Everything else iterates {@link AGENT_SPECS}: a hidden agent is fully real to
 * the machinery and merely unadvertised. Surfaces that ask a human to choose
 * should use this instead.
 */
export function visibleAgentSpecs(): AgentSyncSpec[] {
  return AGENT_SPECS.filter((s) => !s.hidden);
}

/** Ids of the agents a user should be offered. */
export function visibleAgentIds(): AgentId[] {
  return visibleAgentSpecs().map((s) => s.id);
}

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
