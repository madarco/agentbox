/**
 * `makeDockerSync` — the co-located `ProviderSync` facade for the docker
 * provider. THIS FILE is "everything docker syncs": one method per shared sync
 * op, each a thin delegation to the existing docker seed/copy/credential/resync
 * function, byte-identical to the pre-facade create path.
 *
 * The handle is closed at construction. Post-create (`dockerProvider.sync(box)`)
 * needs only `{ container }` — it's used for `resyncWorkspace`. The create path
 * builds the full handle (image + the resolved per-tool volume specs) so
 * `seedAgentConfig` / `seedCredentials` can run the volume seeds; create.ts still
 * resolves those specs once and builds the container mounts from them (one source
 * of truth for the `--isolate-*` flags + want-codex/opencode conditionals).
 *
 * NOT here (deliberate carve-out): **workspace seed** — docker's `git worktree
 * add` + `mount --bind` replay of host stash/untracked has no cloud analog (cloud
 * clones), so it stays a provider-specific step called directly by `create()`.
 * See `docs/sync-architecture.md` §"Deliberate non-unifications".
 */

import type {
  CarryApplyResult,
  GitWorktreeRecord,
  ProviderSync,
  ResolvedCarryEntry,
  ResyncResult,
  SyncContext,
} from '@agentbox/core';
import { renderCarryEntries } from '@agentbox/sandbox-core';
import type { ClaudeConfigSpec } from '../claude.js';
import { ensureClaudeVolume, seedSetupSkillIntoVolume } from '../claude.js';
import { syncClaudeCredentials } from '../claude-credentials.js';
import type { CodexConfigSpec } from '../codex.js';
import { ensureCodexVolume, seedCodexAgentsOverride, seedCodexHooks } from '../codex.js';
import type { AgentsConfigSpec } from '../agents.js';
import { ensureAgentsVolume } from '../agents.js';
import type { OpencodeConfigSpec } from '../opencode.js';
import { ensureOpencodeVolume, seedOpencodePlugin } from '../opencode.js';
import { copyCarryPathsToBox, copyHostEnvFilesToBox } from '../host-export.js';
import { resyncWorkspaceFromHost } from '../in-box-git.js';

export interface DockerSyncHandle {
  /** Running container name (all box-side ops target it). */
  container: string;
  /**
   * Box image (ensureRef) used by the throwaway root seed-helper containers.
   * Required for the create-path seeds (`seedAgentConfig`/`seedCredentials`);
   * omitted post-create (those ops don't run then).
   */
  image?: string;
  /** Resolved claude config-volume spec (create-path). */
  claudeSpec?: ClaudeConfigSpec;
  /** Whether the claude config volume is per-box isolated (gates the credential extract). */
  claudeIsolate?: boolean;
  /** Resolved codex spec, or undefined when codex isn't wanted (host has no ~/.codex + no `agentbox codex`). */
  codexSpec?: CodexConfigSpec;
  /** Resolved agents (~/.agents) spec, or undefined when the host has no ~/.agents. */
  agentsSpec?: AgentsConfigSpec;
  /** Resolved opencode spec, or undefined when opencode isn't wanted. */
  opencodeSpec?: OpencodeConfigSpec;
}

/** Guard: the create-path seeds need the box image + resolved claude spec in the handle. */
function requireCreateHandle(
  handle: DockerSyncHandle,
  op: string,
): { image: string; claudeSpec: ClaudeConfigSpec } {
  if (!handle.image || !handle.claudeSpec) {
    throw new Error(
      `dockerSync.${op} requires a create-time handle (image + claudeSpec); it is not available post-create`,
    );
  }
  return { image: handle.image, claudeSpec: handle.claudeSpec };
}

export function makeDockerSync(handle: DockerSyncHandle): ProviderSync {
  return {
    async resyncWorkspace(
      ctx: SyncContext,
      worktrees: GitWorktreeRecord[],
    ): Promise<ResyncResult> {
      // Reproduces `resyncBox`'s empty-worktrees short-circuit, then drives the
      // provider-neutral resync concern through the docker resync ports.
      if (worktrees.length === 0) return { repos: [], hadConflicts: false };
      const repos = await resyncWorkspaceFromHost({
        container: handle.container,
        worktrees,
        onLog: ctx.onLog,
      });
      const hadConflicts = repos.some(
        (r) => r.mergeConflicts.length > 0 || r.overlaySkipped.length > 0,
      );
      return { repos, hadConflicts };
    },

    async seedAgentConfig(ctx: SyncContext): Promise<void> {
      // The per-tool config volume seeds, in create order. Static config +
      // skills + dynamic + box-facts all ride these volume rsyncs / overrides:
      //   - claude:   ensureClaudeVolume (host ~/.claude rsync, carries dynamic
      //               workflows/memory + box-facts via .claude) + the box-only
      //               /agentbox-setup skill seed.
      //   - codex:    ensureCodexVolume + activity hooks + the AGENTS.override.md
      //               box-facts fold.
      //   - agents:   ensureAgentsVolume (~/.agents skills).
      //   - opencode: ensureOpencodeVolume + the state-reporting plugin.
      // Volume *mounts* are built by create.ts from the same specs.
      const { image, claudeSpec } = requireCreateHandle(handle, 'seedAgentConfig');
      const log = ctx.onLog;

      const claudeEnsured = await ensureClaudeVolume(claudeSpec, {
        syncFromHost: true,
        image,
        hostWorkspace: ctx.hostWorkspace,
      });
      if (claudeEnsured.synced) {
        log(`synced ${claudeSpec.volume} from ~/.claude`);
        if ((claudeEnsured.filteredHookCount ?? 0) > 0) {
          log(`filtered ${String(claudeEnsured.filteredHookCount)} host-path hook(s) (paths under ~/)`);
        }
        if (claudeEnsured.installMethodFixed) {
          log('set installMethod=native in synced .claude.json (matches box native install)');
        }
        if (claudeEnsured.aliasedProjectKey) {
          log(`aliased project state for ${ctx.hostWorkspace} -> /workspace in synced .claude.json`);
        }
        if (claudeEnsured.workspaceTrusted) {
          log('pre-trusted /workspace in synced .claude.json (skips the trust dialog)');
        }
      } else if (claudeEnsured.created) {
        log(`created empty volume ${claudeSpec.volume} (no host ~/.claude to sync)`);
      } else {
        log(`reusing volume ${claudeSpec.volume} (no host ~/.claude to sync)`);
      }
      const seeded = await seedSetupSkillIntoVolume(claudeSpec.volume, image);
      if (seeded.seeded) log(`refreshed /agentbox-setup skill into ${claudeSpec.volume}`);

      if (handle.codexSpec) {
        const codexSpec = handle.codexSpec;
        const codexEnsured = await ensureCodexVolume(codexSpec, { syncFromHost: true, image });
        if (codexEnsured.synced) log(`synced ${codexSpec.volume} from ~/.codex`);
        else if (codexEnsured.created) log(`created empty volume ${codexSpec.volume} (no host ~/.codex)`);
        else log(`reusing volume ${codexSpec.volume}`);
        const codexHooks = await seedCodexHooks(codexSpec.volume, image);
        if (codexHooks.seeded) log(`seeded Codex activity hooks into ${codexSpec.volume}`);
        const codexOverride = await seedCodexAgentsOverride(codexSpec.volume, image);
        if (codexOverride.seeded) log(`seeded Codex AGENTS.override.md into ${codexSpec.volume}`);
      }

      if (handle.agentsSpec) {
        const agentsSpec = handle.agentsSpec;
        const agentsEnsured = await ensureAgentsVolume(agentsSpec, { syncFromHost: true, image });
        if (agentsEnsured.synced) log(`synced ${agentsSpec.volume} from ~/.agents`);
        else if (agentsEnsured.created) log(`created empty volume ${agentsSpec.volume}`);
        else log(`reusing volume ${agentsSpec.volume}`);
      }

      if (handle.opencodeSpec) {
        const opencodeSpec = handle.opencodeSpec;
        const opencodeEnsured = await ensureOpencodeVolume(opencodeSpec, { syncFromHost: true, image });
        if (opencodeEnsured.synced) log(`synced ${opencodeSpec.volume} from ~/.config + ~/.local/share opencode`);
        else if (opencodeEnsured.created) log(`created empty volume ${opencodeSpec.volume} (no host opencode)`);
        else log(`reusing volume ${opencodeSpec.volume}`);
        const opencodePlugin = await seedOpencodePlugin(opencodeSpec.volume, image);
        if (opencodePlugin.seeded) log(`seeded agentbox-state plugin into ${opencodeSpec.volume}`);
      }
    },

    async seedCredentials(ctx: SyncContext): Promise<void> {
      // Mirror the in-box OAuth credentials with the host backup: extract a
      // box-written `.credentials.json` out, or seed a fresh volume from a
      // previous login. syncClaudeCredentials decides the direction; isolate
      // boxes are read-seed only. Best-effort (never throws).
      const { image, claudeSpec } = requireCreateHandle(handle, 'seedCredentials');
      const credSync = await syncClaudeCredentials(claudeSpec, {
        image,
        isolate: handle.claudeIsolate ?? false,
      });
      if (credSync.direction === 'extracted') {
        ctx.onLog('extracted box claude credentials to host backup');
      } else if (credSync.direction === 'seeded') {
        ctx.onLog(`seeded claude credentials into ${claudeSpec.volume} from host backup`);
      }
    },

    // Docker has no separate post-create credential extract: the box shares the
    // host's real auth via the config volume, and `seedCredentials` already does
    // the bidirectional volume↔host-backup sync (extract branch of
    // syncClaudeCredentials) at create. So `dockerProvider` omits
    // `extractAgentCredentials` and this peer method is a documented no-op.
    extractCredentials(): Promise<string[]> {
      return Promise.resolve([]);
    },

    // Docker bind-mounts the host's ~/.gitconfig straight into the box, so there
    // is nothing to seed. Documented no-op (the cloud body copies it in).
    seedGitIdentity(): Promise<void> {
      return Promise.resolve();
    },

    async seedEnvFiles(ctx: SyncContext, patterns: string[]): Promise<{ copied: number }> {
      return copyHostEnvFilesToBox({
        container: handle.container,
        workspaceDir: ctx.hostWorkspace,
        patterns,
        onLog: ctx.onLog,
      });
    },

    async applyCarry(ctx: SyncContext, entries: ResolvedCarryEntry[]): Promise<CarryApplyResult> {
      // Render `replaceEnvs`/`replace` entries host-side (placeholder + rule
      // substitution) then apply the per-entry tar copy.
      const rendered = await renderCarryEntries(
        entries,
        {
          name: ctx.boxName,
          id: ctx.boxId,
          kind: 'docker',
          hostWorkspace: ctx.hostWorkspace,
          projectRoot: ctx.projectRoot,
        },
        ctx.onLog,
      );
      return copyCarryPathsToBox({ container: handle.container, entries: rendered, onLog: ctx.onLog });
    },
  };
}
