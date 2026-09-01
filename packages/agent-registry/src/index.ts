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
import { piSpec } from './specs/pi.js';
import { pluginAgentSpecs } from './plugin-agents.js';
import type { AgentId, AgentSyncSpec } from '@agentbox/core';

/**
 * Canonical order — claude first, matching the order these rows had when they
 * lived in one table. `list`, the dashboard and the pickers all present agents
 * in this order, so it is a user-visible fact, not an implementation detail.
 */
export const BUILTIN_AGENT_SPECS: readonly AgentSyncSpec[] = [
  claudeSpec,
  codexSpec,
  opencodeSpec,
  piSpec,
  exampleSpec,
];

/**
 * Built-ins plus whatever `agentbox agent add` registered, resolved once at
 * import.
 *
 * A snapshot rather than a live read because ~50 call sites treat this as a
 * constant, and a plugin agent appearing halfway through a create would be far
 * worse than one that appears on the next command. Every CLI invocation is a
 * fresh process, so "the next command" is immediately; the long-lived host
 * processes (relay, hub) pick it up on restart, and {@link allAgentSpecs} is
 * there for a caller that must not wait for one.
 *
 * A built-in always wins: a plugin cannot shadow a shipped agent, the same rule
 * `plugin add` enforces for providers.
 */
export const AGENT_SPECS: readonly AgentSyncSpec[] = mergeAgentSpecs(
  BUILTIN_AGENT_SPECS,
  pluginAgentSpecs(),
);

function mergeAgentSpecs(
  builtins: readonly AgentSyncSpec[],
  plugins: readonly AgentSyncSpec[],
): readonly AgentSyncSpec[] {
  // Aliases count as taken too, or a plugin claiming `claude-code` would
  // silently capture every `agentbox claude-code`.
  const taken = new Set(builtins.flatMap((s) => [s.id, ...s.aliases]));
  const extra = plugins.filter((s) => ![s.id, ...s.aliases].some((n) => taken.has(n)));
  return [...builtins, ...extra];
}

/**
 * Re-read the plugin registry and return the current set. For a long-lived
 * process that must see an agent added since it started — the relay answering
 * `agents.list` for a box created a moment ago.
 */
export function allAgentSpecs(): readonly AgentSyncSpec[] {
  return mergeAgentSpecs(BUILTIN_AGENT_SPECS, pluginAgentSpecs());
}

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

/** Every built-in agent id, in canonical order. Excludes plugin agents. */
export function builtinAgentIds(): AgentId[] {
  return BUILTIN_AGENT_SPECS.map((s) => s.id);
}

/**
 * The spec for `id`, or undefined. Resolves aliases (`claude-code` -> claude),
 * because persisted queue jobs and box records still carry the wire spelling.
 */
export function findAgentSpec(id: string): AgentSyncSpec | undefined {
  return AGENT_SPECS.find((s) => s.id === id || s.aliases.includes(id));
}

export {
  AGENTS_FILE,
  AGENTS_FILE_VERSION,
  SUPPORTED_AGENT_API_VERSIONS,
  isSupportedAgentApiVersion,
  agentSpecProblem,
  readAgentRegistrySync,
  pluginAgentSpecs,
  pluginForAgent,
  addAgentPluginRecord,
  removeAgentPluginRecord,
  type AgentPluginRecord,
  type AgentsFile,
} from './plugin-agents.js';
