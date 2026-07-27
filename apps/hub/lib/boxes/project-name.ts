/**
 * Human-readable project/repo name for the hosted (control-box) box source.
 *
 * The LOCAL hub labels a project with `path.basename(projectRoot)` — the repo's
 * last path segment (see `lib/hub-backend.ts`). The hosted source has no local
 * checkout to read, so a box registered on a remote hub arrived here with only
 * its git identity (`originUrl`) and custody key (`projectSlug`). Deriving the
 * same last-segment label from those keeps the remote hub's project cards
 * readable and consistent with the local hub, instead of falling straight back
 * to a box name (or worse, the opaque base64url grouping key).
 *
 * Pure and dependency-free so it unit-tests against plain strings.
 */

export interface RepoNameParts {
  /** The box repo's origin remote URL, any git shape. Absent for boxes without a git origin. */
  originUrl?: string | null;
  /** Custody `projects/<slug>` key (`owner__repo`), when the box registered one. */
  projectSlug?: string | null;
  /** The box name — the last-resort label when there is no git identity. */
  name: string;
}

/**
 * The repo's last path segment from any common git origin URL, stripped of a
 * `.git` suffix and a trailing slash — the same value `path.basename` yields for
 * a local checkout. Returns undefined when nothing usable can be parsed.
 *
 * Handles `https://host/owner/repo(.git)`, `git@host:owner/repo(.git)`, and
 * `ssh://git@host/owner/repo(.git)` by splitting on both `/` and `:`.
 */
export function repoNameFromOrigin(originUrl: string): string | undefined {
  const tail = originUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split(/[/:]/)
    .filter((s) => s.length > 0)
    .pop();
  return tail && tail.length > 0 ? tail : undefined;
}

/** The repo half of a custody slug (`owner__repo` -> `repo`), or undefined. */
export function repoNameFromSlug(slug: string): string | undefined {
  const tail = slug
    .split('__')
    .filter((s) => s.length > 0)
    .pop();
  return tail && tail.length > 0 ? tail : undefined;
}

/**
 * A readable project name, preferring the repo (from the origin URL, then the
 * custody slug) and falling back to the box name so a box with no git identity
 * still gets a label rather than an empty string.
 */
export function repoNameFromRegistration(reg: RepoNameParts): string {
  if (reg.originUrl) {
    const fromOrigin = repoNameFromOrigin(reg.originUrl);
    if (fromOrigin) return fromOrigin;
  }
  if (reg.projectSlug) {
    const fromSlug = repoNameFromSlug(reg.projectSlug);
    if (fromSlug) return fromSlug;
  }
  return reg.name;
}
