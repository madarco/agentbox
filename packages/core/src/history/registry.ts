import type { AgentHistoryModule } from './types.js';

// Registered by each agent package (`registerClaudeAgent`), looked up by the hub's
// history service. Same inverted direction as `registerAgentSyncModule`.
const MODULES = new Map<string, AgentHistoryModule>();

export function registerAgentHistoryModule(mod: AgentHistoryModule): void {
  MODULES.set(mod.id, mod);
}

export function agentHistoryModule(id: string): AgentHistoryModule | undefined {
  return MODULES.get(id);
}
