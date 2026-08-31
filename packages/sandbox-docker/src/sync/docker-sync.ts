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
import { dryRunProviderSync, SYNC_DRYRUN_ENV } from '@agentbox/core';
import { AGENT_SYNC_SPECS, renderCarryEntries } from '@agentbox/sandbox-core';
import type { AgentSyncSpec } from '@agentbox/sandbox-core';
import { seedAgentDeclaredFiles, seedLabels } from './agents/seed.js';
import { requireAgentSyncModule, type AgentVolumeChoice } from './agents/module.js';
import { syncClaudeCredentials } from './claude-credentials.js';
import type { AgentsConfigSpec } from './agents/skills.js';
import { ensureAgentsVolume } from './agents/skills.js';
import { copyCarryPathsToBox, copyHostEnvFilesToBox } from './host-export.js';
import { resyncWorkspaceFromHost } from './in-box-git.js';

export interface DockerSyncHandle {
  /** Running container name (all box-side ops target it). */
  container: string;
  /**
   * Box image (ensureRef) used by the throwaway root seed-helper containers.
   * Required for the create-path seeds (`seedAgentConfig`/`seedCredentials`);
   * omitted post-create (those ops don't run then).
   */
  image?: string;
  /**
   * Resolved config-volume spec per agent, keyed by agent id. Absent key = that
   * agent isn't wanted in this box (the host has no `~/.codex` and the caller
   * didn't ask for codex, say).
   *
   * Keyed rather than one field per agent: the three named fields grew three
   * near-identical branches below, and the divergence between them is how
   * `afterVolumeSync` came to run for codex only. A map has one branch.
   */
  agentSpecs?: Record<string, AgentVolumeChoice>;
  /** Whether the claude config volume is per-box isolated (gates the credential extract). */
  claudeIsolate?: boolean;
  /** Resolved agents (~/.agents) spec, or undefined when the host has no ~/.agents. */
  agentsSpec?: AgentsConfigSpec;
}

/**
 * Guard: the create-path seeds need the box image in the handle.
 *
 * `agentSpecs` is deliberately NOT required — a box selected for one agent has
 * no volume for the others, and demanding one here would make one-agent-per-box
 * impossible. An absent key is simply an agent this box doesn't have.
 */
/**
 * Where an agent's config comes from on the host, for the progress line —
 * derived from its `staticPaths` rather than written per agent, so a new agent
 * gets a truthful line instead of a missing one.
 */
function hostSourceLabel(spec: AgentSyncSpec): string {
  const paths = spec.staticPaths.map((sp) => `~/${sp.hostHomeRel.join('/')}`);
  return paths.length > 0 ? paths.join(' + ') : `~/.${spec.id}`;
}

function requireCreateHandle(handle: DockerSyncHandle, op: string): { image: string } {
  if (!handle.image) {
    throw new Error(
      `dockerSync.${op} requires a create-time handle (image); it is not available post-create`,
    );
  }
  return { image: handle.image };
}

export function makeDockerSync(handle: DockerSyncHandle): ProviderSync {
  if (process.env[SYNC_DRYRUN_ENV]) return dryRunProviderSync('docker');
  return {
    async resyncWorkspace(ctx: SyncContext, worktrees: GitWorktreeRecord[]): Promise<ResyncResult> {
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
      //   - every wanted agent: its module's `ensureVolume` (host config rsync),
      //     its declared `seeds`, then its `afterVolumeSync`.
      //   - agents: ensureAgentsVolume (~/.agents skills) — not an agent.
      // Volume *mounts* are built by create.ts from the same specs.
      const { image } = requireCreateHandle(handle, 'seedAgentConfig');
      const log = ctx.onLog;
      // Agentbox-owned files (activity hooks, the state plugin, the wizard
      // skill) come from `AgentSyncSpec.seeds` — one declaration the cloud path
      // runs too, instead of three hand-written per-agent seeders that only
      // docker ever called.
      const seedDeclared = async (agent: string, volume: string): Promise<void> => {
        const { seeded } = await seedAgentDeclaredFiles(agent, volume, image);
        for (const label of seedLabels(agent, seeded)) log(`seeded ${label} into ${volume}`);
      };

      // One loop, in registry order. There is no per-agent branch left here:
      // which volume, where it comes from and what to seed into it are all the
      // agent's own data, and the post-sync step is the agent's own code.
      for (const spec of AGENT_SYNC_SPECS) {
        const choice = handle.agentSpecs?.[spec.id];
        if (!choice) continue;
        const mod = requireAgentSyncModule(spec.id);
        // `hostWorkspace` is passed to every agent, not just claude: it is a
        // fact about the box, and an agent that doesn't rewrite host-scoped
        // state simply ignores it.
        const ensured = await mod.ensureVolume(choice, {
          syncFromHost: true,
          image,
          hostWorkspace: ctx.hostWorkspace,
        });
        if (ensured.synced) log(`synced ${choice.volume} from ${hostSourceLabel(spec)}`);
        else if (ensured.created)
          log(`created empty volume ${choice.volume} (no host ${hostSourceLabel(spec)})`);
        else log(`reusing volume ${choice.volume}`);
        // An ensure can report more than created/synced — claude's filters host
        // hooks, coerces the install method, aliases the project key and
        // pre-trusts the workspace. Those travel as free-form notes so the
        // shared contract keeps no field only one agent can fill.
        for (const note of ensured.notes ?? []) log(note);

        await seedDeclared(spec.id, choice.volume);

        // Every agent's post-sync step, not just codex's. Codex's AGENTS.override
        // fold was called by name here and the hook was wired into that one
        // branch, so an agent implementing it was silently skipped.
        for (const note of (await mod.afterVolumeSync?.(choice.volume, image))?.notes ?? []) {
          log(`${note} (${choice.volume})`);
        }
      }

      // `~/.agents` is the cross-agent skills tree, not an agent: no module, no
      // seeds, shared across boxes. It stays a separate step for that reason.
      if (handle.agentsSpec) {
        const agentsSpec = handle.agentsSpec;
        const agentsEnsured = await ensureAgentsVolume(agentsSpec, { syncFromHost: true, image });
        if (agentsEnsured.synced) log(`synced ${agentsSpec.volume} from ~/.agents`);
        else if (agentsEnsured.created) log(`created empty volume ${agentsSpec.volume}`);
        else log(`reusing volume ${agentsSpec.volume}`);
      }
    },

    async seedCredentials(ctx: SyncContext): Promise<void> {
      // Mirror the in-box OAuth credentials with the host backup: extract a
      // box-written `.credentials.json` out, or seed a fresh volume from a
      // previous login. syncClaudeCredentials decides the direction; isolate
      // boxes are read-seed only. Best-effort (never throws).
      const { image } = requireCreateHandle(handle, 'seedCredentials');
      // Nothing to mirror when this box wasn't created for claude.
      const claudeSpec = handle.agentSpecs?.claude;
      if (!claudeSpec) return;
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
      return copyCarryPathsToBox({
        container: handle.container,
        entries: rendered,
        onLog: ctx.onLog,
      });
    },
  };
}
