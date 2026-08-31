/**
 * Claude Code as a package.
 *
 * Last of the three to move, deliberately: it is the daily driver, and it is the
 * one whose `ensureVolume` reports more than created/synced. Those extra
 * outcomes travel as `notes` rather than as interface fields only Claude could
 * fill, and `hostWorkspace` reaches it through the ensure options — the one
 * channel the contract grew to accommodate it.
 */

import { registerAgentSyncModule, type AgentSyncModule } from '@agentbox/sandbox-docker';
import {
  buildClaudeMounts,
  claudeSessionInfo,
  ensureClaudeVolume,
  resolveClaudeVolume,
  warmUpClaudeCredentials,
} from './docker-sync.js';

/**
 * Claude reports four outcomes the other agents have no equivalent for. They
 * become notes so the shared contract keeps no column only one agent can fill.
 */
function ensureNotes(
  r: Awaited<ReturnType<typeof ensureClaudeVolume>>,
  hostWorkspace: string | undefined,
): string[] {
  const notes: string[] = [];
  if (r.filteredHookCount && r.filteredHookCount > 0) {
    notes.push(`filtered ${String(r.filteredHookCount)} host-path hook(s) (paths under ~/)`);
  }
  if (r.installMethodFixed) {
    notes.push('set installMethod=native in synced .claude.json (matches box native install)');
  }
  if (r.aliasedProjectKey && hostWorkspace) {
    notes.push(`aliased project state for ${hostWorkspace} -> /workspace in synced .claude.json`);
  }
  if (r.workspaceTrusted) {
    notes.push('pre-trusted /workspace in synced .claude.json (skips the trust dialog)');
  }
  return notes;
}

/** Claude's docker behavior. */
export const claudeSyncModule: AgentSyncModule = {
  id: 'claude',
  resolveVolume: (opts) => resolveClaudeVolume(opts),
  buildMounts: (spec, env) => buildClaudeMounts(spec, env),
  ensureVolume: async (spec, opts) => {
    const r = await ensureClaudeVolume(spec, {
      syncFromHost: opts.syncFromHost,
      image: opts.image,
      hostWorkspace: opts.hostWorkspace,
    });
    return { created: r.created, synced: r.synced, notes: ensureNotes(r, opts.hostWorkspace) };
  },
  sessionInfo: (container) => claudeSessionInfo(container),
  // Claude's OAuth token expires on its own; the others' do not.
  warmUpCredentials: async (volume, image, opts) => {
    const r = await warmUpClaudeCredentials(volume, image, opts ?? {});
    return { warmed: r.warmed, notes: r.warmed ? ['claude credentials warmed'] : [] };
  },
};

/** Register Claude. Called by `@agentbox/agent-modules`. */
export function registerClaudeAgent(): void {
  registerAgentSyncModule(claudeSyncModule);
}

export * from './docker-sync.js';
