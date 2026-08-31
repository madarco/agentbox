/**
 * Claude Code as a package.
 *
 * Last of the three to move, deliberately: it is the daily driver, and it is the
 * one whose `ensureVolume` reports more than created/synced. Those extra
 * outcomes travel as `notes` rather than as interface fields only Claude could
 * fill, and `hostWorkspace` reaches it through the ensure options — the one
 * channel the contract grew to accommodate it.
 */

import {
  registerAgentSyncModule,
  syncClaudeCredentials,
  type AgentSyncModule,
} from '@agentbox/sandbox-docker';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { hostClaudeAccessTokenExpired } from './cli/host-cred-guards.js';
import { registerAgentCloudModule, type AgentCloudModule } from '@agentbox/sandbox-cloud';
import { stageClaudeCredentialsForUpload, stageClaudeStaticForUpload } from './host-stage.js';
import { seedClaudeJsonAtCreate } from './cloud-json-overlay.js';
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
  // Gated on claude's OWN access-token expiry: when the backup's token is still
  // valid the docker round-trip is skipped entirely (~1-2s, and almost always a
  // noop on a fresh token). That gate asks "is this blob worth refreshing?",
  // never "is this login dead?" — the two are different questions and conflating
  // them produced a daily false alarm.
  refreshHostBackup: async (image, log) => {
    if (!(await hostClaudeAccessTokenExpired())) return;
    log('claude: host credentials backup expired — refreshing from docker shared volume');
    const r = await syncClaudeCredentials(
      { volume: resolveAgentSpec('claude').dockerVolume },
      { image, isolate: false },
    );
    if (r.direction === 'extracted') {
      log('claude: refreshed host credentials backup from docker shared volume');
    } else if (r.direction === 'noop') {
      log('claude: no docker shared volume to refresh from (continuing with existing backup)');
    }
  },
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
  // The `_claude.json` overlay, at the same point in the create sequence it has
  // always run: after the declared seeds land, before dynamic config. It used
  // to be called by name from `cloud-sync.ts`; `afterDeclaredSeeds` exists so
  // moving it here did not move it in the sequence.
  afterDeclaredSeeds: (backend, handle, opts) => seedClaudeJsonAtCreate(backend, handle, opts),
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
export * from './host-stage.js';
export * from './hooks-filter.js';
export * from './cloud-json-overlay.js';

export { claudeStagedItems } from './staged-items.js';
