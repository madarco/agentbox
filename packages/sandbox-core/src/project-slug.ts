/**
 * Custody project-slug derivation, shared by every producer/consumer of the
 * `projects/<slug>/…` custody scope (secrets push, seed push, plane
 * registration, hub worker). All of them MUST agree on the slug for the same
 * repo, so the parsing lives here rather than in each caller.
 *
 * The slug is `owner__repo` (double underscore — `/` is not a valid custody
 * path segment character), derived from the repo's origin URL in any of the
 * usual git shapes:
 *   https://github.com/owner/repo(.git)
 *   git@github.com:owner/repo(.git)
 *   ssh://git@github.com/owner/repo(.git)
 */
import { basename } from 'node:path';

/** Parse `owner`/`repo` out of any common git remote URL shape, or null. */
export function ownerRepoFromOriginUrl(originUrl: string): { owner: string; repo: string } | null {
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
      // different slugs (`re%20po` -> `re-20po` vs `re po` -> `re-po`) — which
      // is exactly the drift this shared helper exists to prevent.
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
export function projectSlugFromOriginUrl(originUrl: string): string | null {
  const parsed = ownerRepoFromOriginUrl(originUrl);
  if (!parsed) return null;
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '-');
  return `${clean(parsed.owner)}__${clean(parsed.repo)}`;
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
