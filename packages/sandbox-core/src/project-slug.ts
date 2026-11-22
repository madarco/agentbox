/**
 * Custody project-slug derivation, shared by every producer/consumer of the
 * `projects/<slug>/…` custody scope (secrets push, seed push, plane
 * registration, hub worker, cp cache). All of them MUST agree on the slug for
 * the same repo, so the derivation lives here rather than in each caller.
 *
 * The slug is a function of the repo key (`repoKey` in `@agentbox/config`):
 * `github.com__owner__repo`. It used to be `owner__repo` parsed straight from
 * the URL, which was case-sensitive, ignored the host and dropped GitLab
 * subgroups. Readers still try that legacy slug after the new one
 * ({@link custodySlugCandidates}) so custody written before the change keeps
 * answering; writers write the new slug only.
 */
import { basename } from 'node:path';
import {
  custodySlugForRepoKey,
  getMachineLabel,
  ownerRepoFromOriginUrl,
  repoKey,
  tryGetMachineId,
} from '@agentbox/config';
import { resolveSshConfigTarget } from './ssh-config-probe.js';

export {
  custodySlugCandidates,
  legacyProjectSlugFromOriginUrl,
  ownerRepoFromOriginUrl,
} from '@agentbox/config';

/** Custody `projects/<slug>` key for an origin URL (key-derived), or null. */
export function projectSlugFromOriginUrl(originUrl: string): string | null {
  return custodySlugForRepoKey(repoKey(originUrl));
}

/**
 * The custody slug a PC writes under: {@link projectSlugFromOriginUrl} of the
 * alias-expanded key ({@link repoKeyAtEdge}). Writers on the PC use this;
 * readers try {@link custodySlugCandidates}.
 */
export async function projectSlugAtEdge(
  originUrl: string | undefined | null,
): Promise<string | null> {
  return custodySlugForRepoKey(await repoKeyAtEdge(originUrl));
}

/** What a box registration records about where its repo came from. */
export interface RegistrationOrigin {
  /** The repo key, alias-expanded on this machine. */
  repoKey?: string;
  /** `getMachineId()` of the machine the workspace was seeded from. */
  originMachineId?: string;
  /** That machine's hostname, display only. */
  originMachineLabel?: string;
}

/**
 * Stamp for a registration made on THIS machine: the repo key of `originUrl`,
 * plus this machine as the origin when `folder` is a real checkout here. A
 * control box's per-job clone is deleted the moment the create returns, so a
 * hub-built box has no origin machine to ask for files later.
 */
export async function registrationOrigin(args: {
  originUrl?: string | null;
  folder?: string | null;
}): Promise<RegistrationOrigin> {
  const out: RegistrationOrigin = {};
  const key = await repoKeyAtEdge(args.originUrl);
  if (key) out.repoKey = key;
  const id = tryGetMachineId();
  if (id && args.folder && !isHubWorkerClone(args.folder)) {
    out.originMachineId = id;
    out.originMachineLabel = getMachineLabel();
  }
  return out;
}

const sshHostCache = new Map<string, string | null>();

/**
 * The repo key of `originUrl` as THIS machine sees it: `~/.ssh/config` host
 * aliases expanded through `ssh -G` (non-http(s) remotes only), and a
 * local-path remote keyed by this machine's id. Run on the PC, never on the
 * hub, which has a different (or no) ssh config; the hub accepts the result as
 * sent.
 */
export async function repoKeyAtEdge(
  originUrl: string | undefined | null,
): Promise<string | undefined> {
  if (!originUrl) return undefined;
  const machineId = tryGetMachineId();
  let aliasHost: string | undefined;
  // First pass only learns which host (if any) is aliasable.
  repoKey(originUrl, {
    expandHost: (h) => {
      aliasHost = h;
      return null;
    },
  });
  let expanded: string | null = null;
  if (aliasHost !== undefined) {
    if (sshHostCache.has(aliasHost)) {
      expanded = sshHostCache.get(aliasHost) ?? null;
    } else {
      const target = await resolveSshConfigTarget(aliasHost).catch(() => null);
      expanded = target?.host.trim() || null;
      sshHostCache.set(aliasHost, expanded);
    }
  }
  return repoKey(originUrl, {
    expandHost: () => expanded,
    ...(machineId ? { machineId } : {}),
  });
}

/**
 * Prefix of the per-job clone a control box builds every box from
 * (`$TMPDIR/agentbox-hub-worker-<jobId>`), deleted the moment the create
 * returns. Exported so the producer (`hub-worker.ts`'s `tmpDir`) and every
 * consumer can't drift — a rename on one side silently resurrects the ghost
 * project cards this is used to filter out.
 *
 * Lives here, in a package both `apps/hub` and `apps/cli` depend on, because
 * both sides have to recognize the path: the hub to key a project by its repo
 * instead of a directory that no longer exists, the CLI to avoid printing that
 * directory in `agentbox ls`.
 */
export const HUB_WORKER_CLONE_PREFIX = 'agentbox-hub-worker-';

/**
 * True for a control box's throwaway per-job checkout.
 *
 * Deliberately a NAME test, not an existence test: during the minute a create is
 * running the directory is still there, and a PC-created box's `hostMainRepo`
 * legitimately doesn't exist on the control box while still being a real,
 * durable folder on the PC that we do want to group by.
 */
export function isHubWorkerClone(dir: string): boolean {
  return basename(dir).startsWith(HUB_WORKER_CLONE_PREFIX);
}

/** `owner/repo` from a clone URL, else the URL unchanged. */
export function deriveRepoLabel(originUrl: string): string {
  const parsed = ownerRepoFromOriginUrl(originUrl);
  return parsed ? `${parsed.owner}/${parsed.repo}` : originUrl;
}

/**
 * What to derive a box's default name from when its workspace path is a control
 * box's per-job clone — the repo name, so a hub-created box reads `optima-<id>`
 * instead of `agentbox-hub-worker-<uuid>-<id>`. Null when the URL isn't
 * parseable, leaving the caller on its existing workspace-basename default.
 */
export function boxNameBasisFromOriginUrl(originUrl: string): string | null {
  return ownerRepoFromOriginUrl(originUrl)?.repo ?? null;
}
