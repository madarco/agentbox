/**
 * `makeCloudSync` — the co-located `ProviderSync` facade for the cloud providers
 * (one shared default over any `CloudBackend`). THIS FILE is "everything a cloud
 * box syncs": one method per shared sync op, each a thin delegation to the
 * existing cloud seed/upload/credential function, byte-identical to the
 * pre-facade `createCloudProvider.create()` path.
 *
 * Handle: the backend is closed over by `createCloudProvider`; `makeCloudSync`
 * additionally closes the per-box `CloudHandle`. The create path passes the
 * resolved credential-volume `agents` (from `ensureAgentVolumesForCloud`) so
 * `seedCredentials` knows which agents have a volume to seed — the cloud analog
 * of docker's handle-carries-specs. Post-create (`provider.sync(box)`) omits it;
 * only `resyncWorkspace` (7.5) + `extractCredentials` run then.
 *
 * NOT here (deliberate carve-outs, mirroring docker): **workspace seed**
 * (`seedCloudWorkspace` — the in-box clone / checkpoint overlay, no facade analog)
 * and the **static agent config** (baked into the snapshot at `prepare`, not a
 * runtime seed). Both are referenced by create() directly. See
 * `docs/sync-architecture.md` §"Deliberate non-unifications".
 */

import type {
  CarryApplyResult,
  CloudBackend,
  CloudHandle,
  GitWorktreeRecord,
  ProviderSync,
  ResolvedCarryEntry,
  ResyncResult,
  SyncContext,
} from '@agentbox/core';
import { dryRunProviderSync, SYNC_DRYRUN_ENV } from '@agentbox/core';
import { renderCarryEntries } from '@agentbox/sandbox-core';
import { resyncCloudWorkspace } from './workspace-resync.js';
import {
  type CloudAgentKind,
  ensureAgentHomeDirsOwned,
  extractCloudAgentCredentials,
  refreshAgentCredentialsBackup,
  seedAgentVolumesIfFresh,
  seedOpencodeModelState,
} from './agent-credentials.js';
import { seedDynamicConfig } from './dynamic-sync.js';
import { ensureCodexAgentsOverride } from './codex-agents-override.js';
import { seedClaudeJsonAtCreate } from './claude-json-overlay.js';
import { seedGitIdentity as seedCloudGitIdentity } from './git-identity.js';
import { uploadEnvFiles } from './env-files.js';
import { uploadCarryPaths } from './carry.js';

export interface CloudSyncOptions {
  /**
   * Agent kinds with a credentials volume/dir to seed (create-path). From
   * `ensureAgentVolumesForCloud(...).agents`. Omitted post-create.
   */
  agents?: CloudAgentKind[];
}

export function makeCloudSync(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: CloudSyncOptions = {},
): ProviderSync {
  if (process.env[SYNC_DRYRUN_ENV]) return dryRunProviderSync(backend.name);
  return {
    // Cloud live-box resync: pre-fetch the host commits into the box, then run
    // the shared resync concern (merge + overlay, box wins; never reset --hard).
    // See workspace-resync.ts. The provider's resyncWorkspace(box) re-derives the
    // worktrees (detectGitRepos) + gates on hostSeeded before calling here.
    async resyncWorkspace(
      ctx: SyncContext,
      worktrees: GitWorktreeRecord[],
    ): Promise<ResyncResult> {
      if (worktrees.length === 0) return { repos: [], hadConflicts: false };
      const repos = await resyncCloudWorkspace(backend, handle, worktrees, ctx.onLog);
      const hadConflicts = repos.some(
        (r) => r.mergeConflicts.length > 0 || r.overlaySkipped.length > 0,
      );
      return { repos, hadConflicts };
    },

    async seedAgentConfig(ctx: SyncContext): Promise<void> {
      // The runtime agent-config seeds (static config is baked into the snapshot
      // at prepare). In create order:
      //   - normalize the agent static-config home dirs to vscode ownership;
      //   - fold the box facts into ~/.codex/AGENTS.override.md;
      //   - seed the host's OpenCode model into the box state dir;
      //   - overlay ~/.claude/_claude.json from the host's ~/.claude.json;
      //   - seed the dynamic Claude config (workflows/ + this project's memory/).
      await ensureAgentHomeDirsOwned(backend, handle, { onLog: ctx.onLog });
      await ensureCodexAgentsOverride(backend, handle, { onLog: ctx.onLog });
      await seedOpencodeModelState(backend, handle, { onLog: ctx.onLog });
      await seedClaudeJsonAtCreate(backend, handle, {
        hostWorkspace: ctx.hostWorkspace,
        onLog: ctx.onLog,
      });
      await seedDynamicConfig(backend, handle, {
        workspacePath: ctx.hostWorkspace,
        onLog: ctx.onLog,
      });
    },

    async seedCredentials(ctx: SyncContext): Promise<void> {
      // Refresh the host-side backups from the docker shared volumes (best-effort,
      // gated on expiry) BEFORE pushing them into the box, then seed the per-agent
      // credentials (volume backends: idempotent via marker; ephemeral: push fresh).
      await refreshAgentCredentialsBackup({ onLog: ctx.onLog });
      const agents = opts.agents ?? [];
      if (agents.length > 0) {
        await seedAgentVolumesIfFresh(backend, handle, {
          agents,
          hostWorkspace: ctx.hostWorkspace,
          onLog: ctx.onLog,
        });
      }
    },

    extractCredentials(): Promise<string[]> {
      // Capture the box's agent login(s) back to the host backups. Cloud-only
      // (the box has no shared host auth path); the CLI calls it on
      // `checkpoint create --set-default`.
      return extractCloudAgentCredentials(backend, handle);
    },

    async seedGitIdentity(ctx: SyncContext): Promise<void> {
      // Cloud boxes have no bind-mounted ~/.gitconfig, so configure a committer
      // identity (host user when resolvable, else a generic agentbox identity).
      await seedCloudGitIdentity(backend, handle, {
        hostRepo: ctx.hostWorkspace,
        onLog: ctx.onLog,
      });
    },

    async seedEnvFiles(ctx: SyncContext, patterns: string[]): Promise<{ copied: number }> {
      return uploadEnvFiles({
        backend,
        handle,
        workspacePath: ctx.hostWorkspace,
        files: patterns,
        workspaceDir: ctx.boxWorkspace,
        onLog: ctx.onLog,
      });
    },

    async applyCarry(ctx: SyncContext, entries: ResolvedCarryEntry[]): Promise<CarryApplyResult> {
      const rendered = await renderCarryEntries(
        entries,
        {
          name: ctx.boxName,
          id: ctx.boxId,
          kind: 'cloud',
          hostWorkspace: ctx.hostWorkspace,
          projectRoot: ctx.projectRoot,
        },
        ctx.onLog,
      );
      return uploadCarryPaths({ backend, handle, entries: rendered, onLog: ctx.onLog });
    },
  };
}
