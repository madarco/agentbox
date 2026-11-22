/**
 * Which machines can answer a box→host file request, in the order to try
 * (docs/box-sources-plan.md §4). Pure: multi-PC Phase 4 calls it with the
 * registry and its own idea of who is online, and does the routing.
 */
import { posix } from 'node:path';
import { custodySlugForRepoKey, repoKey as repoKeyOf } from '@agentbox/config';
import { cpCacheKey, cpCachePrefix, cpCachePrefixes } from '../cp-cache.js';
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
  /**
   * The root repo's cp-cache prefixes, best first (`cpCachePrefixes(reg)`),
   * legacy slugs included. Derived from the root repo's key when absent.
   */
  cachePrefixes?: string[];
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
      /**
       * The custody fallback, always present: `prefix` is where a capture
       * writes, `readPrefixes` every prefix to try (new slug first, legacy
       * `owner__repo` after), `key` the entry within it.
       */
      cacheKey: { prefix: string; readPrefixes: string[]; key: string };
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

  // Keyed exactly as today's capture keys it, so existing entries still hit:
  // the request as the box spelled it (`./x` -> `rel:x`, `/workspace/x` ->
  // `abs:/workspace/x`, a host path -> `abs:<path>`), under the ROOT repo's
  // prefixes (`cpCachePrefixes(reg)`: the repo-key slug to write, then the
  // legacy slugs to read). Only a NESTED repo, which no capture has keyed yet,
  // gets its own slug and a key relative to its own root.
  const root = box.repos.find((r) => r.path === BOX_WORKSPACE);
  const nestedRepo = repo && repo !== root ? repo : undefined;
  let readPrefixes: string[];
  if (nestedRepo) {
    const slug = custodySlugForRepoKey(nestedRepo.repoKey);
    readPrefixes = [cpCachePrefix({ ...(slug ? { projectSlug: slug } : {}), boxId: box.boxId })];
  } else if (box.cachePrefixes && box.cachePrefixes.length > 0) {
    readPrefixes = [...box.cachePrefixes];
  } else {
    const slug = custodySlugForRepoKey(root?.repoKey);
    readPrefixes = [cpCachePrefix({ ...(slug ? { projectSlug: slug } : {}), boxId: box.boxId })];
  }
  const key = cpCacheKey(nestedRepo ? relPath : raw);
  return {
    ok: true,
    ...(repo ? { repo } : {}),
    relPath,
    candidates,
    cacheKey: { prefix: readPrefixes[0]!, readPrefixes, key },
  };
}

/**
 * The lookup's view of a registration today: one root repo at `/workspace`,
 * keyed by the registered repo key. Phase 2 derives it from `sources`.
 */
export function candidateBoxFromRegistration(
  reg: Pick<
    BoxRegistration,
    'boxId' | 'repoKey' | 'originUrl' | 'projectSlug' | 'originMachineId' | 'worktrees'
  >,
): CandidateBox {
  const root = reg.worktrees?.find((w) => w.containerPath === BOX_WORKSPACE);
  // A registration from before the repo key existed: derive it (unexpanded)
  // from the origin, as the cp-cache prefix does.
  const key = reg.repoKey ?? repoKeyOf(reg.originUrl);
  return {
    boxId: reg.boxId,
    cachePrefixes: cpCachePrefixes(reg),
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
