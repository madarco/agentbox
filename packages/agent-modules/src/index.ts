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
 * Agents still inside `sandbox-docker` register themselves from its
 * `builtins.ts`; each one leaves that file as it becomes a package, and this
 * list grows to replace it.
 */

import { registerCodexAgent } from '@agentbox/agent-codex';
import { registerOpencodeAgent } from '@agentbox/agent-opencode';

/**
 * Register every agent this build ships. Idempotent — registering twice
 * replaces the entry rather than duplicating it, so calling from both the CLI
 * and an embedded hub is safe.
 */
export function registerAllAgentModules(): void {
  registerCodexAgent();
  registerOpencodeAgent();
}
