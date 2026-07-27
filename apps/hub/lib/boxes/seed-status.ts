import 'server-only';

import { seedSlugFor } from './seed-slug';
// Type-only — importing the CustodyStore VALUE (FsCustodyStore) here would bundle
// @agentbox/relay (→ execa) into the /api/v1/projects/{id}/seed route and
// ERR_MODULE_NOT_FOUND in the standalone build. We reach the live store through
// `globalThis.__AGENTBOX_HUB_CUSTODY` instead (set by server.ts, out of Next's
// bundle), exactly like the /api/v1/custody route.
import type { CustodyEntry } from '@agentbox/relay/control-plane';

export { seedSlugFor };

/*
 * Seed / custody status for one project, read from the control box's custody
 * store (`projects/<slug>/seed/…`). This is what `agentbox hub project push`
 * writes: two tarballs (untracked + env/secret files) plus a manifest of what
 * was captured, from which commit, when.
 *
 * The contract is the same as `agentbox hub custody list`: PATHS, HASHES and
 * TIMESTAMPS only — never the bytes of a seed blob. The manifest itself is
 * metadata (origin, branch, HEAD, per-blob sha256/size), so returning its
 * fields is in-contract; the `.tar.gz` payloads are never read.
 */

/** One stored seed blob — path, size, hash, last-write time. No contents. */
export interface SeedEntry {
  /** Custody path relative to `projects/<slug>/seed/`, e.g. `untracked.tar.gz`. */
  name: string;
  size: number;
  sha256: string;
  updatedAt: string;
}

export interface ProjectSeedStatus {
  slug: string;
  /** Origin the seed was captured from, per the manifest. */
  originUrl?: string;
  /** Branch checked out when the seed was captured. */
  baseBranch?: string;
  /** Full commit the working tree sat on (the UI shows a short prefix). */
  repoHeadSha?: string;
  /** When the seed was last captured (manifest `createdAt`). */
  capturedAt?: string;
  /** env/secret tarball present (secrets travelled with the seed). */
  hasEnv: boolean;
  /** untracked-files tarball present. */
  hasUntracked: boolean;
  /** Total bytes across every stored seed blob. */
  totalBytes: number;
  /** Every stored seed blob — the authoritative custody listing. */
  entries: SeedEntry[];
}

export interface ProjectSeedResult {
  /** False when this hub is not a control box (no custody store / admin token). */
  custodyAvailable: boolean;
  /** Null when custody is unavailable or nothing has been pushed for this project. */
  seed: ProjectSeedStatus | null;
}

/** The manifest fields we surface — a subset of the seed's `manifest.json`. */
interface SeedManifestShape {
  originUrl?: string;
  baseBranch?: string;
  repoHeadSha?: string;
  createdAt?: string;
}

/**
 * The live custody store, or null when this hub holds none (no admin token — a
 * localhost hub, or the plane/Postgres path). Set by server.ts outside Next's
 * bundle; a structural `list`/`get` handle, never `new FsCustodyStore()` (which
 * would drag @agentbox/relay → execa into this route's bundle).
 */
function custodyOrNull(): NonNullable<typeof globalThis.__AGENTBOX_HUB_CUSTODY> | null {
  return globalThis.__AGENTBOX_HUB_CUSTODY ?? null;
}

function toEntry(e: CustodyEntry, prefix: string): SeedEntry {
  return {
    name: e.path.startsWith(`${prefix}/`) ? e.path.slice(prefix.length + 1) : e.path,
    size: e.size,
    sha256: e.sha256,
    updatedAt: e.updatedAt,
  };
}

/**
 * Read the seed/custody status for a project slug. Best-effort: a missing seed
 * or an unreadable manifest degrades to the listing (or `seed: null`), never an
 * error — the project page must still render its other details.
 */
export async function getProjectSeedStatus(slug: string | null): Promise<ProjectSeedResult> {
  const custody = custodyOrNull();
  if (!custody) return { custodyAvailable: false, seed: null };
  if (!slug) return { custodyAvailable: true, seed: null };

  const prefix = `projects/${slug}/seed`;
  const entries = await custody.list(prefix).catch(() => []);
  if (entries.length === 0) return { custodyAvailable: true, seed: null };

  const seedEntries = entries.map((e) => toEntry(e, prefix));
  const names = new Set(seedEntries.map((e) => e.name));

  let manifest: SeedManifestShape = {};
  if (names.has('manifest.json')) {
    const got = await custody.get(`${prefix}/manifest.json`).catch(() => null);
    if (got) {
      try {
        manifest = JSON.parse(got.data.toString('utf8')) as SeedManifestShape;
      } catch {
        // A corrupt manifest costs only the metadata lines; the listing still shows.
      }
    }
  }

  return {
    custodyAvailable: true,
    seed: {
      slug,
      originUrl: manifest.originUrl,
      baseBranch: manifest.baseBranch,
      repoHeadSha: manifest.repoHeadSha,
      capturedAt: manifest.createdAt,
      hasEnv: names.has('env.tar.gz'),
      hasUntracked: names.has('untracked.tar.gz'),
      totalBytes: seedEntries.reduce((n, e) => n + e.size, 0),
      entries: seedEntries,
    },
  };
}
