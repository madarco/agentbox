/**
 * What this package needs from an agent, as ONE interface it RECEIVES rather
 * than three modules it imports.
 *
 * `sandbox-docker` used to import `claude.ts`, `codex.ts` and `opencode.ts`
 * directly, which is why a fourth agent could not be added without editing this
 * package. It cannot import them once each agent is its own package either: an
 * agent's behavior depends on `sandbox-docker`, so importing it back is the
 * dependency cycle turbo already refused (see `agent-registry`).
 *
 * So the direction inverts. Agents REGISTER; this package looks them up. Same
 * shape `check-cloud-backend-wiring.mjs` already guards for cloud backends,
 * where the relay is handed a loader rather than importing providers.
 *
 * The method set is not invented — it is exactly what a grep of this package's
 * imports showed it actually uses, with the three names per concept collapsed to
 * one.
 */

import type { AgentId } from '@agentbox/core';

/** A live tmux session probe. The three agents' versions were byte-identical. */
export interface AgentSessionInfo {
  running: boolean;
  sessionName: string;
  /** ISO-8601 from tmux's `#{session_created}`, or null when not running. */
  startedAt: string | null;
}

/** Which config volume a box uses for one agent. */
export interface AgentVolumeChoice {
  /** Resolved docker volume name mounted at the agent's box config dir. */
  volume: string;
}

/**
 * What an agent contributes to `docker run`. The three agents' mount results
 * were already identical field-for-field.
 */
export interface AgentMountResult {
  /** `-v` spec strings appended to `runBox(extraVolumes)`. */
  extraVolumes: string[];
  /** Env forwarded into the container; only host keys that were set + non-empty. */
  env: Record<string, string>;
  volumeName: string;
}

/**
 * Outcome of seeding an agent's volume.
 *
 * `created`/`synced` are common to all three. Claude reports more (dropped host
 * hooks, trust/alias writes) and keeps doing so through `notes`, rather than
 * widening this shape with fields only one agent can populate — the mistake the
 * per-agent result types made.
 */
export interface EnsureAgentVolumeResult {
  /** True only the very first time the volume is created on this host. */
  created: boolean;
  /** True when the host→volume sync actually ran. */
  synced: boolean;
  /** Human-readable lines the create log prints verbatim. */
  notes?: string[];
}

/** One agent's docker-side behavior. */
export interface AgentSyncModule {
  readonly id: AgentId;

  /** Pick the config volume: the shared one, or a per-box volume when isolated. */
  resolveVolume(opts: { isolate: boolean; boxId: string }): AgentVolumeChoice;

  /** Mounts + env this agent contributes to `docker run`. */
  buildMounts(spec: AgentVolumeChoice, hostEnv: NodeJS.ProcessEnv): AgentMountResult;

  /**
   * Create the volume if absent and seed it from the host config.
   *
   * `hostWorkspace` is passed because an agent may need to rewrite host-scoped
   * state as it syncs — claude aliases its `projects[<hostWorkspace>]` key to
   * `/workspace` so the in-box session sees the host's project state. Optional:
   * an agent that does not care simply ignores it.
   */
  ensureVolume(
    spec: AgentVolumeChoice,
    opts: { syncFromHost: boolean; image: string; hostWorkspace?: string },
  ): Promise<EnsureAgentVolumeResult>;

  /** Probe the agent's tmux session in a running box. */
  sessionInfo(container: string): Promise<AgentSessionInfo>;

  /**
   * Anything the agent needs done to its volume AFTER the sync. Absorbs what
   * were per-agent one-offs called by name from `docker-sync.ts` — codex's
   * `AGENTS.override.md` box-facts fold is the first.
   */
  afterVolumeSync?(volume: string, image: string): Promise<{ notes: string[] }>;

  /**
   * Refresh a credential that expires on its own, before a box starts.
   * Claude-only today; optional because most agents' tokens do not expire.
   *
   * `attempts` and `onProgress` are here because renewing is a real, slow,
   * fallible operation the host reports on as it goes — not a fire-and-forget.
   */
  warmUpCredentials?(
    volume: string,
    image: string,
    opts?: { attempts?: number; onProgress?: (line: string) => void },
  ): Promise<{ warmed: boolean; notes: string[] }>;

  /**
   * Bring this agent's HOST credential backup up to date from its docker volume,
   * before a box starts.
   *
   * `dockerCredentialRefresh` used to do this for three agents by name — a
   * claude sync gated on claude's token expiry, then a codex extract, then an
   * opencode extract. A fourth agent got no refresh at all, silently, which is
   * the same gap `assert-creds` and the cloud volume table each had.
   *
   * Optional, and best-effort by contract: the caller swallows throws, so an
   * agent with nothing to refresh omits it and one whose docker volume is
   * missing simply reports no change.
   */
  refreshHostBackup?(image: string, log: (line: string) => void): Promise<void>;
}

/**
 * The registered agents.
 *
 * Populated by whoever assembles the app — the CLI at startup, a test in its
 * setup. This package never fills it in, which is the point.
 */
const MODULES = new Map<AgentId, AgentSyncModule>();

/** Register (or replace) one agent's docker behavior. */
export function registerAgentSyncModule(mod: AgentSyncModule): void {
  MODULES.set(mod.id, mod);
}

/** Every registered agent, in registration order. */
export function registeredAgentSyncModules(): AgentSyncModule[] {
  return [...MODULES.values()];
}

/**
 * One agent's module, or undefined when it has none.
 *
 * Deliberately NOT throwing: a box may legitimately reference an agent this
 * build has no docker behavior for (a registry row added ahead of its package,
 * or a cloud-only agent). Callers skip; they must not crash a create.
 */
export function agentSyncModule(id: AgentId): AgentSyncModule | undefined {
  return MODULES.get(id);
}

/**
 * The module for `id`, or a thrown error naming it.
 *
 * For call sites that cannot proceed without it. The throw is the point: an
 * unpopulated registry otherwise reads as "this box has no agents", which is a
 * silent wrong answer rather than a failure.
 */
export function requireAgentSyncModule(id: AgentId): AgentSyncModule {
  const mod = MODULES.get(id);
  if (!mod) {
    throw new Error(
      `no docker sync module registered for agent '${id}' — ` +
        `the app must register it before creating or inspecting a box`,
    );
  }
  return mod;
}
