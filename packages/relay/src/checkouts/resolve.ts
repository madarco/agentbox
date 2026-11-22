/**
 * Which machines can answer a box→host file request, in the order to try
 * (docs/box-sources-plan.md §4). Pure: multi-PC Phase 4 calls it with the
 * registry and its own idea of who is online, and does the routing.
 */
import { posix } from 'node:path';
import { custodySlugForRepoKey, repoKey as repoKeyOf } from '@agentbox/config';
import { cpCacheKey, cpCachePrefix } from '../cp-cache.js';
import type { BoxRegistration } from '../types.js';
import type { CheckoutRecord } from './types.js';

/** Where every box's workspace is mounted. */
export const BOX_WORKSPACE = '/workspace';

/** One repo of a box, as the lookup needs it. */
export interface CandidateRepo {
  /** Checkout path inside the box (`/workspace`, `/workspace/web`). */
  path: string;
  /** Alias-expanded repo key; absent for a repo with no remote. */
  repoKey?: string;
  /** The folder it was seeded from on the origin machine, when known. */
  originFolder?: string;
}

/** A box as the lookup sees it. Phase 2's `BoxSources` replaces `repos`. */
export interface CandidateBox {
  boxId: string;
  /** `getMachineId()` of the machine the box was seeded from. */
  originMachineId?: string;
  repos: CandidateRepo[];
}

export interface HostCandidate {
  machineId: string;
  /** The repo's folder on that machine; absent for the origin when unknown. */
  folder?: string;
  reason: 'origin' | 'has-repo';
}

export type HostCandidatesResult =
  | {
      ok: true;
      /** The repo whose checkout path prefixes the request (longest wins). */
      repo?: CandidateRepo;
      /** The request relative to that repo's root; the request itself otherwise. */
      relPath: string;
      candidates: HostCandidate[];
      /** The custody fallback, always present. */
      cacheKey: { prefix: string; key: string };
    }
  | { ok: false; error: string };

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/**
 * The lookup for `boxPath`, as the box asked for it:
 *
 * - relative (`data.csv`, `./web/x`): resolved against `/workspace`, the root
 *   repo, like today's `cp fromHost ./x`;
 * - `/workspace/...`: a path inside the box's checkouts;
 * - any other absolute path: a path on the origin machine's disk, which only
 *   that machine can answer.
 *
 * Order: (1) the origin machine, if online; (2) any other online machine with
 * a checkout of the repo, newest report first; (3) the custody cache (always
 * returned as `cacheKey`). A request outside every repo, or in a repo with no
 * key, gets only (1) then (3): a machine with a different checkout never
 * serves a file.
 */
export function hostCandidatesFor(
  box: CandidateBox,
  boxPath: string,
  checkouts: readonly CheckoutRecord[],
  online: (machineId: string) => boolean,
): HostCandidatesResult {
  const raw = boxPath.trim();
  if (raw.length === 0) return { ok: false, error: 'empty path' };
  const relative = !raw.startsWith('/');
  const inBox = relative ? posix.join(BOX_WORKSPACE, raw) : posix.normalize(raw);

  // A relative path that climbs out of /workspace (`../x`) names something on
  // the origin machine's disk next to the project: origin only, like an
  // absolute host path.
  let repo: CandidateRepo | undefined;
  if (within(inBox, BOX_WORKSPACE)) {
    for (const r of box.repos) {
      if (within(inBox, r.path) && (!repo || r.path.length > repo.path.length)) repo = r;
    }
    if (relative && !repo) {
      const paths = box.repos.map((r) => r.path);
      return {
        ok: false,
        error:
          paths.length > 0
            ? `${raw} is relative but the box has no repo at ${BOX_WORKSPACE}; use one of: ${paths.join(', ')}`
            : `${raw} is relative but the box has no repo to resolve it against`,
      };
    }
  }

  const relPath = repo ? posix.relative(repo.path, inBox) || '.' : raw;
  const candidates: HostCandidate[] = [];
  const origin = box.originMachineId;
  if (origin && online(origin)) {
    const theirs = repo?.repoKey
      ? checkouts.find((c) => c.machineId === origin && c.repoKey === repo.repoKey)
      : undefined;
    const folder = theirs?.folder ?? repo?.originFolder;
    candidates.push({ machineId: origin, ...(folder ? { folder } : {}), reason: 'origin' });
  }
  if (repo?.repoKey) {
    const seen = new Set<string>(origin ? [origin] : []);
    const others = checkouts
      .filter((c) => c.repoKey === repo.repoKey && !seen.has(c.machineId) && online(c.machineId))
      .sort((a, b) => b.seenAt.localeCompare(a.seenAt));
    for (const c of others) {
      if (seen.has(c.machineId)) continue;
      seen.add(c.machineId);
      candidates.push({ machineId: c.machineId, folder: c.folder, reason: 'has-repo' });
    }
  }

  // Keyed as today's capture keys it: a repo-relative request is `rel:<path>`
  // under the repo's slug, so every machine with the repo reads and writes one
  // entry. A host-absolute path keeps its `abs:` key under the root repo's prefix.
  // A request outside every repo is still filed under the box's ROOT repo
  // slug, which is where a live capture writes it (`cpCachePrefixes(reg)[0]`).
  const scopeRepo = repo ?? box.repos.find((r) => r.path === BOX_WORKSPACE);
  const slug = scopeRepo ? custodySlugForRepoKey(scopeRepo.repoKey) : null;
  const prefix = cpCachePrefix({ ...(slug ? { projectSlug: slug } : {}), boxId: box.boxId });
  const key = cpCacheKey(repo ? relPath : raw);
  return { ok: true, ...(repo ? { repo } : {}), relPath, candidates, cacheKey: { prefix, key } };
}

/**
 * The lookup's view of a registration today: one root repo at `/workspace`,
 * keyed by the registered repo key. Phase 2 derives it from `sources`.
 */
export function candidateBoxFromRegistration(
  reg: Pick<BoxRegistration, 'boxId' | 'repoKey' | 'originUrl' | 'originMachineId' | 'worktrees'>,
): CandidateBox {
  const root = reg.worktrees?.find((w) => w.containerPath === BOX_WORKSPACE);
  // A registration from before the repo key existed: derive it (unexpanded)
  // from the origin, as the cp-cache prefix does.
  const key = reg.repoKey ?? repoKeyOf(reg.originUrl);
  return {
    boxId: reg.boxId,
    ...(reg.originMachineId ? { originMachineId: reg.originMachineId } : {}),
    repos: [
      {
        path: BOX_WORKSPACE,
        ...(key ? { repoKey: key } : {}),
        ...(root?.hostMainRepo ? { originFolder: root.hostMainRepo } : {}),
      },
    ],
  };
}
