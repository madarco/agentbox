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
import { registerAgentCloudModule, type AgentCloudModule } from '@agentbox/sandbox-cloud';
import {
  stageClaudeCredentialsForUpload,
  stageClaudeStaticForUpload,
} from '@agentbox/sandbox-core';
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

/**
 * Claude's cloud behavior.
 *
 * `afterSeed` is a no-op today: claude's cloud post-seed step
 * (`seedClaudeJsonAtCreate`) is still called by name from `cloud-sync.ts`
 * because it runs AFTER the declared files and needs `hostWorkspace`, so
 * folding it into the loop would move it in the sequence — worth verifying
 * against a real cloud box before doing.
 *
 * The staging hooks are the point of registering now: without them the cloud
 * credential path could not look claude up by id, and its rows were the reason
 * that table was hardcoded.
 */
export const claudeCloudModule: AgentCloudModule = {
  id: 'claude',
  afterSeed: () => Promise.resolve(),
  // Claude's staging filters host-path hooks, coerces the install method,
  // aliases the project key and pre-trusts the workspace — more than a copy of
  // its declared paths, so it supplies its own.
  stageStatic: (opts) => stageClaudeStaticForUpload({ hostWorkspace: opts.hostWorkspace }),
  stageCredentials: () => stageClaudeCredentialsForUpload(),
};

/** Register Claude on both layers. Called by `@agentbox/agent-modules`. */
export function registerClaudeAgent(): void {
  registerAgentSyncModule(claudeSyncModule);
  registerAgentCloudModule(claudeCloudModule);
}

export * from './docker-sync.js';
