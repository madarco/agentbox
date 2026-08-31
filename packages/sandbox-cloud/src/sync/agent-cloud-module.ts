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

/** A staged tarball, or an empty result when the host has nothing to send. */
export interface CloudStageResult {
  tarballPath: string | null;
  cleanup(): Promise<void>;
  warnings: string[];
}

/** One agent's cloud-side behavior. */
export interface AgentCloudModule {
  readonly id: AgentId;
  /**
   * Stage this agent's host credentials for upload into the shared credentials
   * volume.
   *
   * Optional: an agent with no host-side credential to send simply has none,
   * and gets a mount with nothing seeded into it rather than being dropped from
   * the box entirely — which is what a hardcoded table did to it before.
   */
  stageCredentials?(): Promise<CloudStageResult>;
  /**
   * Stage this agent's static config. Optional for the same reason, and rarely
   * needed: `stageAllAgentStatic` already covers any agent from its registry
   * row. Only an agent whose staging is more than a copy supplies one.
   */
  stageStatic?(opts: { hostWorkspace?: string }): Promise<CloudStageResult>;
  /**
   * Run AFTER this agent's declared `seeds` are placed, before dynamic config.
   *
   * A separate hook from `afterSeed` because the POSITION matters: claude's
   * `_claude.json` overlay has to see the seeded files already on disk, and it
   * needs `hostWorkspace` to alias the host's project key onto `/workspace`.
   * Folding it into `afterSeed` would move it earlier in the sequence — a
   * behaviour change dressed up as a refactor.
   */
  afterDeclaredSeeds?(
    backend: CloudBackend,
    handle: CloudHandle,
    opts: { hostWorkspace?: string; onLog?: (line: string) => void },
  ): Promise<void>;
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
