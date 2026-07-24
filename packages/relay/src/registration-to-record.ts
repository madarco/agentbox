/**
 * Rebuild a drivable `BoxRecord` from a control-box `BoxRegistration`.
 *
 * The single source of truth for "registration → record" reconstruction, used by
 * BOTH sides of the control-plane topology:
 *   - the PC's `agentbox hub adopt` (materializes the record into the PC's
 *     `state.json` so direct PC↔box commands resolve the box), and
 *   - the control box's own hub backend (`hydrateRegisteredBox`), which drives a
 *     box it knows only from its Store registration — created on a PC / another
 *     host — so `/api/v1` lifecycle, git, and REAL destroy work on it, not just a
 *     state reap.
 *
 * Everything needed rides on the registration (the adoption material added by the
 * plane-register enrichment): provider, sandbox id, public VM host, image, web
 * port, agent, branch, origin URL, bridge/preview tokens. Host-specific concerns
 * stay with the caller: which LOCAL project the box maps to (PC only — the
 * control box has no local clone), SSH-key material (downloaded from custody over
 * HTTP on the PC, read from the local FS store on the control box), and the token
 * generator used for the relay/bridge fallbacks.
 *
 * Kept pure (no fs, no network) so both callers layer their own IO around it.
 */
import type { BoxRecord, GitWorktreeRecord, SshTargetRecord } from '@agentbox/core';
import { boxSshDirForProvider } from '@agentbox/sandbox-core';
import type { BoxRegistration } from './types.js';

/** Box user on every cloud provider's image (the agent never runs as root). */
const BOX_SSH_USER = 'vscode';

export interface RegistrationToRecordOptions {
  /** The control-plane base URL, persisted on the record's cloud fields. */
  controlPlaneUrl: string;
  /**
   * A local record for the same box, when re-adopting: its id/project linkage
   * and live tokens are preserved so status paths stay stable and a refresh
   * never re-mints tokens already injected in the running box.
   */
  existing?: BoxRecord;
  /**
   * Absolute host path of the LOCAL checkout the box maps to. Set only when a
   * clone is present (the PC path); on the control box there is none, so git
   * worktree bookkeeping is left off (the registration's `hostMainRepo` is the
   * control box's create-time temp clone, deleted after create — carrying it
   * over would point host-side git RPCs at a path that doesn't exist).
   */
  projectRoot?: string;
  /** 1-based per-project box index, when the caller resolved one. */
  projectIndex?: number;
  /** Fallback token generator for the relay/bridge tokens (e.g. `generateRelayToken`). */
  freshToken: () => string;
}

/** Narrow a registration's free-form agent string to the record's union. */
export function normalizeRegistrationAgent(agent: string | undefined): BoxRecord['lastAgent'] {
  return agent === 'claude' || agent === 'codex' || agent === 'opencode' ? agent : undefined;
}

/**
 * The box's SSH target, or undefined when the registration carries no host.
 *
 * `identityFile` is set only when the provider actually mints a per-box key dir:
 * a provider that reports a `publicHost` but no keypair would otherwise get a
 * bogus absolute `"/id_ed25519"` written into the record. Omitting it leaves ssh
 * to its normal key resolution.
 */
export function buildSshTarget(
  provider: string,
  sandboxId: string,
  publicHost: string | undefined,
): SshTargetRecord | undefined {
  if (!publicHost) return undefined;
  const dir = boxSshDirForProvider(provider, sandboxId);
  return {
    host: publicHost,
    user: BOX_SSH_USER,
    ...(dir ? { identityFile: `${dir}/id_ed25519` } : {}),
  };
}

/**
 * Map a `BoxRegistration` (+ caller-supplied host context) to a `BoxRecord`.
 * Pure: it neither reads SSH keys nor writes state — the caller does that around
 * it. Idempotent-friendly: pass `existing` to preserve local identity on refresh.
 */
export function registrationToBoxRecord(
  reg: BoxRegistration,
  opts: RegistrationToRecordOptions,
): BoxRecord {
  const provider = reg.backend ?? 'docker';
  const sandboxId = reg.sandboxId ?? reg.boxId;
  const { existing, projectRoot, projectIndex, controlPlaneUrl, freshToken } = opts;

  const branch = reg.worktrees?.[0]?.branch ?? `agentbox/${reg.name}`;
  const sanctionedBranch = reg.worktrees?.[0]?.sanctionedBranch ?? branch;

  // Git worktree bookkeeping points at the LOCAL clone (PC only). On the control
  // box `projectRoot` is undefined → no worktrees, which is correct: cloud
  // lifecycle/destroy need none, and host-side git RPCs would have no repo here.
  const gitWorktrees: GitWorktreeRecord[] | undefined = projectRoot
    ? [
        {
          kind: 'root',
          branch,
          sanctionedBranch,
          containerPath: '/workspace',
          hostMainRepo: projectRoot,
          gitWorktreePath: '',
          relPathFromWorkspace: '',
        },
      ]
    : undefined;

  return {
    id: existing?.id ?? reg.boxId,
    name: reg.name,
    displayName: existing?.displayName,
    provider,
    container: `cloud:${sandboxId}`,
    image: reg.image ?? existing?.image ?? '',
    workspacePath: projectRoot ?? existing?.workspacePath ?? '/workspace',
    projectRoot,
    projectIndex,
    // Tokens are regenerated only for a fresh adoption; a re-adopt keeps the
    // box's live tokens (already injected in the running box).
    relayToken: existing?.relayToken ?? reg.token ?? freshToken(),
    lastAgent: normalizeRegistrationAgent(reg.agent) ?? existing?.lastAgent,
    gitWorktrees,
    createdAt: reg.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
    ssh: buildSshTarget(provider, sandboxId, reg.publicHost) ?? existing?.ssh,
    cloud: {
      ...existing?.cloud,
      backend: provider,
      sandboxId,
      image: reg.image ?? existing?.cloud?.image,
      webPort: reg.webPort ?? existing?.cloud?.webPort,
      publicHost: reg.publicHost ?? existing?.cloud?.publicHost,
      bridgeToken: reg.bridgeToken ?? existing?.cloud?.bridgeToken ?? freshToken(),
      relayPreviewUrl: reg.previewUrl ?? existing?.cloud?.relayPreviewUrl,
      relayPreviewToken: reg.previewToken ?? existing?.cloud?.relayPreviewToken,
      workspaceBranch: branch,
      sanctionedBranch,
      lastState: existing?.cloud?.lastState ?? 'running',
      topology: 'control-plane',
      controlPlaneUrl,
      // A hub-created box clones in-box from a leased URL — it shares no fork
      // base with a PC, so the session-start live resync must skip it.
      hostSeeded: undefined,
    },
  };
}
