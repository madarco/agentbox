/**
 * What the cloud sync layer needs from an agent, as one interface it RECEIVES.
 *
 * The docker twin of this is `AgentSyncModule` in `@agentbox/sandbox-docker`.
 * This one is separate rather than a field on that interface for a dependency
 * reason: its methods take `CloudBackend` / `CloudHandle`, which live in the
 * cloud layer — and the cloud layer depends on the docker one, not the reverse.
 * A cloud hook hanging off the docker contract would invert that.
 *
 * `cloud-sync.ts` used to call `ensureCodexAgentsOverride`,
 * `seedOpencodeModelState` and `seedClaudeJsonAtCreate` by name, in sequence.
 * All three have the same signature — one hook wearing three names — and all
 * three are the same idea: something an agent needs done to a freshly seeded
 * cloud box before it is used.
 */

import type { CloudBackend, CloudHandle } from '@agentbox/core';
import type { AgentId } from '@agentbox/core';

/** One agent's cloud-side behavior. */
export interface AgentCloudModule {
  readonly id: AgentId;
  /**
   * Run after the box's agent config has been seeded, before it is used.
   *
   * Best-effort by contract: an implementation logs and returns rather than
   * throwing, because none of these steps is worth failing a create over.
   */
  afterSeed(
    backend: CloudBackend,
    handle: CloudHandle,
    opts: { onLog?: (line: string) => void },
  ): Promise<void>;
}

const MODULES = new Map<AgentId, AgentCloudModule>();

/** Register (or replace) one agent's cloud behavior. */
export function registerAgentCloudModule(mod: AgentCloudModule): void {
  MODULES.set(mod.id, mod);
}

/**
 * Every registered agent's cloud module, in registration order.
 *
 * Order is the registration order, which `@agentbox/agent-modules` fixes — the
 * three seeds ran in a defined sequence before and still do.
 */
export function registeredAgentCloudModules(): AgentCloudModule[] {
  return [...MODULES.values()];
}

/** One agent's cloud module, or undefined when it has none. */
export function agentCloudModule(id: AgentId): AgentCloudModule | undefined {
  return MODULES.get(id);
}
