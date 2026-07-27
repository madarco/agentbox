import { projectSlugFromOriginUrl } from '@agentbox/sandbox-core';

/*
 * Pure custody-slug resolution, shared by the two projects that need it: the
 * synthetic projects the embedded/self-hosted control box builds from a box
 * registration (`hub-backend.ts`) and the seed route's server-only read
 * (`seed-status.ts`). Kept dependency-light (no `server-only`, no store) so it
 * unit-tests against plain objects — a regression here silently empties the
 * seed/custody panel on the primary self-hosted control box.
 */

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
 * A project's custody slug: the one it registered with, else derived from its
 * origin URL (the same `owner__repo` derivation every producer uses). Null when
 * the project has neither.
 */
export function seedSlugFor(project: { projectSlug?: string | null; originUrl?: string | null }): string | null {
  if (project.projectSlug) return project.projectSlug;
  if (project.originUrl) return projectSlugFromOriginUrl(project.originUrl);
  return null;
}
