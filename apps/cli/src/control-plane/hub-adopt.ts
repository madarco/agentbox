/**
 * `agentbox hub adopt <box>` — materialize a local `BoxRecord` for a box that
 * lives in the control box's registry (created from the web UI or `--via-hub`).
 *
 * With a control box configured the PC is a thin client: the control box is the
 * source of truth for cloud boxes, and the local `state.json` record is a
 * materialized cache. Adoption is what writes that cache — without it a
 * hub-created box can't be resolved by name at all, because every direct PC↔box
 * command (`attach`, `cp`, `download`, `url`, `screen`, `destroy`) goes
 * `resolveBoxOrExit` → `readState` → provider.
 *
 * Everything needed to rebuild the record rides on the registration (the
 * adoption material added by the plane-register enrichment): provider, sandbox
 * id, public VM IP, image, web port, agent, branch, origin URL. The per-box SSH
 * key material comes from custody (`boxes/<sandboxId>/ssh/`) via the existing
 * `pullBoxSshKeys`.
 *
 * Kept free of command-layer concerns (logging, exit codes, config reads) so it
 * is unit-testable with fake clients + a temp HOME, mirroring `hub-pull.ts`.
 */
import { execa } from 'execa';
import type { BoxRecord, GitWorktreeRecord } from '@agentbox/core';
import { boxSshDirForProvider, readState } from '@agentbox/sandbox-core';
import { generateRelayToken, recordBox } from '@agentbox/sandbox-docker';
import { allocateProjectIndex } from '@agentbox/sandbox-core';
import type { BoxRegistration } from '@agentbox/relay';
import type { CustodyClient } from './custody-client.js';
import type { ControlPlaneAdminClient } from './admin-client.js';
import { pullBoxSshKeys } from './hub-pull.js';

/** Box user on every cloud provider's image (the agent never runs as root). */
const BOX_SSH_USER = 'vscode';

export interface HubAdoptArgs {
  admin: ControlPlaneAdminClient;
  custody: CustodyClient;
  /** Box id, name, or sandbox id as shown by `control-plane boxes list`. */
  ref: string;
  /** The control-plane base URL, persisted on the record's cloud fields. */
  controlPlaneUrl: string;
  /** cwd for origin-URL project matching. Defaults to `process.cwd()`. */
  cwd?: string;
  log?: (line: string) => void;
}

export interface HubAdoptResult {
  record: BoxRecord;
  /** Basenames of SSH key files pulled from custody (empty for e2b/vercel). */
  sshFiles: string[];
  /** Local project the box's origin URL matched, when any. */
  projectRoot?: string;
  /** True when an existing local record was refreshed rather than created. */
  refreshed: boolean;
}

/** Thrown when the ref matches no registration on the control box. */
export class HubBoxNotFoundError extends Error {
  constructor(ref: string) {
    super(`no box matching '${ref}' is registered on the control box`);
    this.name = 'HubBoxNotFoundError';
  }
}

/**
 * Normalize a git remote URL for comparison: drop the scheme, any user@, a
 * trailing `.git`, and case — so `git@github.com:o/r.git`,
 * `https://github.com/o/r`, and `ssh://git@github.com/o/r.git` all match.
 */
export function normalizeOriginUrl(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?=\D)/, '/')
    .replace(/\.git\/?$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** A repo's `origin` remote URL, or undefined when it isn't a repo / has none. */
async function readOriginUrl(dir: string): Promise<string | undefined> {
  const r = await execa('git', ['-C', dir, 'remote', 'get-url', 'origin'], { reject: false });
  const url = (r.stdout ?? '').trim();
  return r.exitCode === 0 && url.length > 0 ? url : undefined;
}

/** Absolute path of the repo root containing `dir`, or undefined. */
async function readRepoRoot(dir: string): Promise<string | undefined> {
  const r = await execa('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { reject: false });
  const root = (r.stdout ?? '').trim();
  return r.exitCode === 0 && root.length > 0 ? root : undefined;
}

/**
 * Find the local checkout for a hub box's origin URL: the cwd's repo first,
 * then any other project already in state with the same origin. Returns the
 * project root, or undefined when this PC has no clone of the repo (the box is
 * still adoptable — it just shows under `ls -g` only).
 */
async function matchLocalProject(
  originUrl: string | undefined,
  cwd: string,
  state: { boxes: BoxRecord[] },
): Promise<string | undefined> {
  if (!originUrl) return undefined;
  const want = normalizeOriginUrl(originUrl);
  const cwdOrigin = await readOriginUrl(cwd).catch(() => undefined);
  if (cwdOrigin && normalizeOriginUrl(cwdOrigin) === want) {
    const root = await readRepoRoot(cwd).catch(() => undefined);
    if (root) return root;
  }
  // Fall back to the project roots of boxes already in state: a repo we've
  // created a box from before is a clone we know the path of.
  const seen = new Set<string>();
  for (const b of state.boxes) {
    const root = b.projectRoot;
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const origin = await readOriginUrl(root).catch(() => undefined);
    if (origin && normalizeOriginUrl(origin) === want) return root;
  }
  return undefined;
}

/** Match a ref against a registration by box id, name, or sandbox id. */
function matchesRef(reg: BoxRegistration, ref: string): boolean {
  return reg.boxId === ref || reg.name === ref || reg.sandboxId === ref;
}

/**
 * Rebuild a local `BoxRecord` from a control-box registration, download the
 * box's SSH key material from custody, and persist it to `state.json`.
 *
 * Idempotent: re-adopting an already-local box refreshes the cached record from
 * the registration while preserving the fields only the PC knows (its id, so
 * status paths stay stable, and any project linkage already resolved).
 */
export async function adoptHubBox(args: HubAdoptArgs): Promise<HubAdoptResult> {
  const log = args.log ?? (() => {});
  const cwd = args.cwd ?? process.cwd();

  const registrations = await args.admin.listBoxes();
  const reg = registrations.find((r) => matchesRef(r, args.ref));
  if (!reg) throw new HubBoxNotFoundError(args.ref);

  const provider = reg.backend ?? 'docker';
  const sandboxId = reg.sandboxId ?? reg.boxId;

  const state = await readState();
  // Re-adopt keeps the existing local identity: the relay writes status.json
  // under a path keyed by the box id + project index, so minting a new id on
  // every refresh would orphan the box's status.
  const existing = state.boxes.find(
    (b) => b.cloud?.sandboxId === sandboxId || b.id === reg.boxId || b.name === reg.name,
  );

  const projectRoot =
    existing?.projectRoot ?? (await matchLocalProject(reg.originUrl, cwd, state));
  const projectIndex =
    existing?.projectIndex ??
    (projectRoot ? allocateProjectIndex(state, projectRoot) : undefined);

  const branch = reg.worktrees?.[0]?.branch ?? `agentbox/${reg.name}`;
  const sanctionedBranch = reg.worktrees?.[0]?.sanctionedBranch ?? branch;

  // Point git worktree bookkeeping at the LOCAL clone. The registration's
  // hostMainRepo is the control box's temp create-time checkout (deleted after
  // create), so carrying it over would make host-side git RPCs run against a
  // path that doesn't exist here.
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

  const record: BoxRecord = {
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
    // box's live tokens (they're already injected in the running box).
    relayToken: existing?.relayToken ?? reg.token ?? generateRelayToken(),
    lastAgent: normalizeAgent(reg.agent) ?? existing?.lastAgent,
    gitWorktrees,
    createdAt: reg.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
    ssh: reg.publicHost
      ? {
          host: reg.publicHost,
          user: BOX_SSH_USER,
          identityFile: `${boxSshDirForProvider(provider, sandboxId) ?? ''}/id_ed25519`,
        }
      : existing?.ssh,
    cloud: {
      ...existing?.cloud,
      backend: provider,
      sandboxId,
      image: reg.image ?? existing?.cloud?.image,
      webPort: reg.webPort ?? existing?.cloud?.webPort,
      publicHost: reg.publicHost ?? existing?.cloud?.publicHost,
      bridgeToken: reg.bridgeToken ?? existing?.cloud?.bridgeToken ?? generateRelayToken(),
      relayPreviewUrl: reg.previewUrl ?? existing?.cloud?.relayPreviewUrl,
      relayPreviewToken: reg.previewToken ?? existing?.cloud?.relayPreviewToken,
      workspaceBranch: branch,
      sanctionedBranch,
      lastState: existing?.cloud?.lastState ?? 'running',
      topology: 'control-plane',
      controlPlaneUrl: args.controlPlaneUrl,
      // A hub-created box clones in-box from a leased URL — it shares no fork
      // base with this PC, so the session-start live resync must skip it.
      hostSeeded: undefined,
    },
  };

  // Key material: only providers that mint a keypair (hetzner/DO) have any.
  // Detected by what's actually in custody rather than by provider name, so a
  // new SSH provider needs no change here.
  const pulled = await pullBoxSshKeys({
    admin: args.admin,
    custody: args.custody,
    box: args.ref,
  }).catch(() => null);
  const sshFiles = pulled?.files ?? [];
  if (sshFiles.length > 0) log(`pulled ${String(sshFiles.length)} SSH key file(s) to ${pulled!.dest}`);

  await recordBox(record);
  return { record, sshFiles, projectRoot, refreshed: existing !== undefined };
}

/** Narrow a registration's free-form agent string to the record's union. */
function normalizeAgent(agent: string | undefined): BoxRecord['lastAgent'] {
  return agent === 'claude' || agent === 'codex' || agent === 'opencode' ? agent : undefined;
}
