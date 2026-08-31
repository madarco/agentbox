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

import { registerClaudeAgent } from '@agentbox/agent-claude';
import { registerCodexAgent } from '@agentbox/agent-codex';
import { registerOpencodeAgent } from '@agentbox/agent-opencode';

/**
 * Register every agent this build ships. Idempotent — registering twice
 * replaces the entry rather than duplicating it, so calling from both the CLI
 * and an embedded hub is safe.
 */
export function registerAllAgentModules(): void {
  registerClaudeAgent();
  registerCodexAgent();
  registerOpencodeAgent();
}
