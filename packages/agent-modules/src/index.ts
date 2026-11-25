/**
 * Every built-in agent's behavior, registered in one call.
 *
 * WHY THIS EXISTS. `sandbox-docker` receives agents rather than importing them
 * (see its `AgentSyncModule`), so something above it has to do the wiring — and
 * there is more than one entry point that creates docker boxes: the CLI, and the
 * hub, which pulls `@agentbox/sandbox-docker` in through its own provider
 * importer. An entry point that forgets shows up as `requireAgentSyncModule`
 * throwing at create time, not as a compile error.
 *
 * So the wiring lives here and each app makes one call. It is the
 * `provider/loaders.ts` analogue for agents: a literal table of the things
 * compiled into this build, sitting above everything it registers.
 *
 * Every shipped agent is now a package and registers from here; the staging
 * `builtins.ts` that used to adapt them inside `sandbox-docker` is gone, which
 * is this phase's own proof — there is no agent implementation left in that
 * package to adapt.
 */

import type { AgentModule } from '@agentbox/cli-kit';
import { registerClaudeAgent } from '@agentbox/agent-claude';
import { registerCodexAgent } from '@agentbox/agent-codex';
import { registerExampleAgent } from '@agentbox/agent-example';
import { registerOpenclawAgent } from '@agentbox/agent-openclaw';
import { registerOpencodeAgent } from '@agentbox/agent-opencode';
import { registerPiAgent } from '@agentbox/agent-pi';

/**
 * Register every agent this build ships. Idempotent — registering twice
 * replaces the entry rather than duplicating it, so calling from both the CLI
 * and an embedded hub is safe.
 */
export function registerAllAgentModules(): void {
  registerClaudeAgent();
  registerCodexAgent();
  registerOpencodeAgent();
  registerPiAgent();
  // The first service agent: a daemon the box hosts, with no CLI module of its
  // own (see @agentbox/agent-openclaw).
  registerOpenclawAgent();
  // Hidden from users, real to the machinery — see @agentbox/agent-example.
  registerExampleAgent();
}

export { registerInstalledAgentModules, type InstalledAgentLoadResult } from './plugins.js';

/**
 * An agent's CLI module (runtime: session start, resume args, session name),
 * for a host process that is not the CLI. The hub uses it to restart a box's
 * agent session on another account (hub settings Phase 3c). Null for an agent
 * this build ships no CLI module for. Lazy: each module is imported on first use.
 */
const CLI_MODULES: Record<string, () => Promise<{ agentModule: AgentModule }>> = {
  claude: () => import('@agentbox/agent-claude/cli'),
  codex: () => import('@agentbox/agent-codex/cli'),
  opencode: () => import('@agentbox/agent-opencode/cli'),
  pi: () => import('@agentbox/agent-pi/cli'),
  example: () => import('@agentbox/agent-example/cli'),
};

export async function loadAgentCliModule(id: string): Promise<AgentModule | null> {
  const importer = CLI_MODULES[id];
  return importer ? (await importer()).agentModule : null;
}
