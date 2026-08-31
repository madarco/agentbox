/**
 * The three shipped agents, adapted to {@link AgentSyncModule} and registered.
 *
 * A STAGING POST, not the destination. Each adapter wraps functions that still
 * live in this package (codex has already left — see `@agentbox/agent-codex`); as an agent moves into `packages/agent-<id>`, its arm
 * here goes away and the app registers the package's module instead. The
 * interface and every call site are converted first so that move is a file move
 * rather than a rewrite — and so the conversion is provable on its own, before
 * anything relocates.
 *
 * Registration happens on import, which this package does from its own entry.
 * That keeps today's behavior exactly: `sandbox-docker` has always had these
 * three compiled in, and nothing yet depends on an outside registration.
 */

import {
  buildClaudeMounts,
  claudeSessionInfo,
  ensureClaudeVolume,
  resolveClaudeVolume,
  warmUpClaudeCredentials,
} from './claude.js';
import {
  buildOpencodeMounts,
  ensureOpencodeVolume,
  opencodeSessionInfo,
  resolveOpencodeVolume,
} from './opencode.js';
import { registerAgentSyncModule, type AgentSyncModule } from './module.js';

const claudeSyncModule: AgentSyncModule = {
  id: 'claude',
  resolveVolume: (opts) => resolveClaudeVolume(opts),
  buildMounts: (spec, env) => buildClaudeMounts(spec, env),
  ensureVolume: async (spec, opts) => {
    const r = await ensureClaudeVolume(spec, opts);
    return { created: r.created, synced: r.synced, notes: claudeNotes(r) };
  },
  sessionInfo: (container) => claudeSessionInfo(container),
  warmUpCredentials: async (volume, image) => {
    const r = await warmUpClaudeCredentials(volume, image, {});
    return { notes: r.warmed ? ['claude credentials warmed'] : [] };
  },
};

/**
 * Claude's ensure reports four extra things the other two have no equivalent
 * for. They become notes rather than interface fields, so the contract does not
 * grow a column only one agent can fill.
 */
function claudeNotes(r: Awaited<ReturnType<typeof ensureClaudeVolume>>): string[] {
  const notes: string[] = [];
  if (r.filteredHookCount && r.filteredHookCount > 0) {
    notes.push(`filtered ${String(r.filteredHookCount)} host-path hook(s)`);
  }
  if (r.installMethodFixed) notes.push('coerced .claude.json install method to native');
  if (r.aliasedProjectKey) notes.push("aliased the host project key to '/workspace'");
  return notes;
}

const opencodeSyncModule: AgentSyncModule = {
  id: 'opencode',
  resolveVolume: (opts) => resolveOpencodeVolume(opts),
  buildMounts: (spec, env) => buildOpencodeMounts(spec, env),
  ensureVolume: async (spec, opts) => ensureOpencodeVolume(spec, opts),
  sessionInfo: (container) => opencodeSessionInfo(container),
};

/** Register the shipped three. Idempotent; safe to call more than once. */
export function registerBuiltinAgentSyncModules(): void {
  registerAgentSyncModule(claudeSyncModule);
  registerAgentSyncModule(opencodeSyncModule);
}

// Registered on import. `sandbox-docker` has always had these three compiled in,
// so doing it here keeps behavior identical while the call sites move onto the
// registry. When an agent becomes a package, its arm leaves this file and the
// app registers it instead.
registerBuiltinAgentSyncModules();
