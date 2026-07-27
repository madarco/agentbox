/*
 * Pure custody-slug resolution, shared by the two projects that need it: the
 * synthetic projects the embedded/self-hosted control box builds from a box
 * registration (`hub-backend.ts`) and the seed route's server-only read
 * (`seed-status.ts`). Kept dependency-light (no `server-only`, no store) so it
 * unit-tests against plain objects — a regression here silently empties the
 * seed/custody panel on the primary self-hosted control box.
 *
 * The slug derivation is inlined below rather than imported from
 * `@agentbox/sandbox-core` (its canonical home, `project-slug.ts`): this module
 * is in the /api/v1/projects/{id}/seed route's bundle scope, and that package's
 * barrel loads execa (serverExternalPackages) → a runtime import ERR_MODULE_NOT_FOUNDs
 * in the standalone build. The copy MUST stay byte-for-byte equivalent to
 * `projectSlugFromOriginUrl` there — both are pinned by unit tests (`owner__repo`).
 */

// ── mirror of @agentbox/sandbox-core project-slug.ts (see note above) ──────────

/** Parse `owner`/`repo` out of any common git remote URL shape, or null. */
function ownerRepoFromOriginUrl(originUrl: string): { owner: string; repo: string } | null {
  const url = originUrl.trim();
  if (url.length === 0) return null;
  let path: string | null = null;
  // scp-like: git@host:owner/repo(.git)
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(url);
  if (scp) {
    path = scp[1]!;
  } else {
    try {
      // Decode: `new URL` percent-encodes the path, while the scp-like branch
      // above doesn't. Without this, the same repo spelled two ways yields two
      // different slugs.
      path = safeDecode(new URL(url).pathname);
    } catch {
      return null;
    }
  }
  const segments = path
    .replace(/\.git\/?$/, '')
    .split('/')
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[segments.length - 2]!;
  const repo = segments[segments.length - 1]!;
  if (owner.length === 0 || repo.length === 0) return null;
  return { owner, repo };
}

/** `decodeURIComponent`, falling back to the raw value on a malformed escape. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Custody `projects/<slug>` key for an origin URL: `owner__repo`, or null. */
function projectSlugFromOriginUrl(originUrl: string): string | null {
  const parsed = ownerRepoFromOriginUrl(originUrl);
  if (!parsed) return null;
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '-');
  return `${clean(parsed.owner)}__${clean(parsed.repo)}`;
}

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
export function seedSlugFor(project: {
  projectSlug?: string | null;
  originUrl?: string | null;
}): string | null {
  if (project.projectSlug) return project.projectSlug;
  if (project.originUrl) return projectSlugFromOriginUrl(project.originUrl);
  return null;
}
