/*
 * Pure custody-slug resolution, shared by the two projects that need it: the
 * synthetic projects the embedded/self-hosted control box builds from a box
 * registration (`hub-backend.ts`) and the seed route's server-only read
 * (`seed-status.ts`). Kept dependency-light (no `server-only`, no store) so it
 * unit-tests against plain objects — a regression here silently empties the
 * seed/custody panel on the primary self-hosted control box.
 *
 * The derivation comes from `@agentbox/config`, not `@agentbox/sandbox-core`:
 * this module is in the /api/v1/projects/{id}/seed route's bundle scope, and
 * sandbox-core's barrel loads execa (serverExternalPackages), which
 * ERR_MODULE_NOT_FOUNDs in the standalone build.
 */
import { custodySlugCandidates } from '@agentbox/config';

/** The git identity a project needs to resolve its custody slug. */
export interface CustodyIdentity {
  originUrl: string | null;
  projectSlug: string | null;
}

/**
 * Thread a box registration's git identity onto its project. Load-bearing for
 * the embedded/self-hosted control box (SQLite store, no Postgres source): its
 * synthetic projects would otherwise carry no slug and the seed panel would
 * render empty even when custody genuinely holds the seed.
 */
export function custodyIdentityFromRegistration(reg: {
  originUrl?: string | null;
  projectSlug?: string | null;
}): CustodyIdentity {
  return { originUrl: reg.originUrl ?? null, projectSlug: reg.projectSlug ?? null };
}

/**
 * A project's custody slugs, best first: the slug of its repo key (alias-
 * expanded where it was computed), the key-derived slug of its origin, the slug
 * it registered with, then the legacy `owner__repo` one custody written by an
 * older CLI still sits under. Empty when it has none of them.
 */
export function seedSlugsFor(project: {
  projectSlug?: string | null;
  originUrl?: string | null;
  repoKey?: string | null;
}): string[] {
  return custodySlugCandidates({
    repoKey: project.repoKey ?? null,
    originUrl: project.originUrl ?? null,
    projectSlug: project.projectSlug ?? null,
  });
}
