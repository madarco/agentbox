/**
 * One identity for a repository, wherever it is checked out and however its
 * remote is spelled. Every machine-independent key derives from it: the
 * workspace project id, the custody slug, and the checkouts registry.
 *
 * Pure and dependency-free on purpose: hub route bundles import it, and a
 * package that pulls execa into those bundles breaks the standalone build. The
 * `~/.ssh/config` alias expansion it needs is therefore injected
 * (`expandHost`); `repoKeyAtEdge` in `@agentbox/sandbox-core` supplies it with
 * `ssh -G`, on the machine whose ssh config it is. The hub never expands: a key
 * the PC computed is accepted as sent.
 */
import { createHash } from 'node:crypto';

export interface RepoKeyOptions {
  /**
   * Resolve an ssh host alias to the real host (`ssh -G <alias>`). Called only
   * for non-http(s) remotes, the only ones `~/.ssh/config` applies to. A
   * null/undefined answer keeps the host as written.
   */
  expandHost?: (host: string) => string | null | undefined;
  /**
   * The machine a local-path remote lives on. A path has no portable identity,
   * so its key is `local:<machineId>:<path>` and matches only on that machine;
   * without a machine id a local path has no key at all.
   */
  machineId?: string;
}

function stripRepoSuffix(s: string): string {
  let out = s;
  while (out.endsWith('/')) out = out.slice(0, -1);
  if (out.toLowerCase().endsWith('.git')) out = out.slice(0, -'.git'.length);
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * The path of a local-path remote (`/srv/app.git`, `file:///srv/app`), case
 * preserved and without the `.git`/trailing slash, else undefined.
 */
export function localRepoPath(raw: string | undefined | null): string | undefined {
  const url = (raw ?? '').trim();
  let path: string | undefined;
  if (url.startsWith('/')) path = url;
  else if (/^file:\/\//i.test(url)) path = url.replace(/^file:\/\//i, '');
  if (path === undefined) return undefined;
  const out = stripRepoSuffix(path.replace(/\/{2,}/g, '/'));
  return out.length > 0 ? out : undefined;
}

/**
 * `host/path` key of a git remote, or undefined for an empty/unparseable value
 * (which then never matches anything).
 *
 * `git@github.com:Owner/Repo.git`, `https://github.com/owner/repo`,
 * `ssh://git@github.com:22/owner/repo/` all become `github.com/owner/repo`:
 * scheme, user, port, trailing `/` and `.git` dropped, host and path
 * lowercased, every path segment kept (GitLab subgroups survive).
 */
export function repoKey(
  raw: string | undefined | null,
  opts: RepoKeyOptions = {},
): string | undefined {
  const url = (raw ?? '').trim();
  if (!url) return undefined;
  const local = localRepoPath(url);
  if (local !== undefined) {
    return opts.machineId ? `local:${opts.machineId}:${local}` : undefined;
  }
  let host: string;
  let path: string;
  let aliasable: boolean;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
  if (scheme) {
    const proto = scheme[1]!.toLowerCase();
    const rest = scheme[2]!;
    const slash = rest.indexOf('/');
    if (slash === -1) return undefined;
    const authority = rest.slice(0, slash);
    host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '');
    // Decoded: a URL may percent-encode what the scp form spells literally.
    path = safeDecode(rest.slice(slash + 1));
    aliasable = proto !== 'http' && proto !== 'https';
  } else {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(url);
    if (scp) {
      host = scp[1]!;
      path = scp[2]!;
      aliasable = true;
    } else {
      // Already key-shaped (`github.com/owner/repo`): a key round-trips.
      const slash = url.indexOf('/');
      if (slash <= 0) return undefined;
      host = url.slice(0, slash);
      path = url.slice(slash + 1);
      aliasable = false;
    }
  }
  if (aliasable && opts.expandHost) {
    const expanded = opts.expandHost(host)?.trim();
    if (expanded) host = expanded;
  }
  const cleanPath = stripRepoSuffix(path.replace(/\/{2,}/g, '/').replace(/^\/+/, ''));
  if (!host || !cleanPath) return undefined;
  return `${host}/${cleanPath}`.toLowerCase();
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Longest custody slug kept verbatim; longer ones are truncated + hashed. */
const MAX_SLUG = 80;

/**
 * Custody `projects/<slug>` segment for a repo key: `<host>__<seg>__<seg>`,
 * sanitised to custody's `[A-Za-z0-9._-]` charset. Null for a local-path key,
 * which has no machine-independent scope.
 */
export function custodySlugForRepoKey(key: string | undefined | null): string | null {
  if (!key || key.startsWith('local:')) return null;
  const segs = key.split('/').filter((s) => s.length > 0);
  if (segs.length < 2) return null;
  const slug = segs.map((s) => s.replace(/[^A-Za-z0-9._-]/g, '-')).join('__');
  if (slug.length <= MAX_SLUG) return slug;
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `${slug.slice(0, MAX_SLUG - 17)}-${digest}`;
}

/** Parse `owner`/`repo` (the last two path segments) out of a git remote URL, or null. */
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
      // `new URL` percent-encodes the path while the scp branch doesn't.
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

/**
 * The pre-repo-key custody slug, `owner__repo`, exactly as it was derived
 * before (case kept, host and subgroups dropped). Read side only: custody
 * written by an older CLI or hub lives under it.
 */
export function legacyProjectSlugFromOriginUrl(originUrl: string): string | null {
  const parsed = ownerRepoFromOriginUrl(originUrl);
  if (!parsed) return null;
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '-');
  return `${clean(parsed.owner)}__${clean(parsed.repo)}`;
}

/**
 * Every custody slug a reader should try for one repo, best first: the slug of
 * the key the PC computed (alias-expanded), the slug of the key derived from
 * the URL here, a slug the registration carried, then the legacy
 * `owner__repo`. Writers use element 0. Empty when the repo has no remote.
 */
export function custodySlugCandidates(src: {
  repoKey?: string | null;
  originUrl?: string | null;
  projectSlug?: string | null;
}): string[] {
  const out: string[] = [];
  const add = (s: string | null | undefined): void => {
    if (s && !out.includes(s)) out.push(s);
  };
  add(custodySlugForRepoKey(src.repoKey));
  if (src.originUrl) add(custodySlugForRepoKey(repoKey(src.originUrl)));
  add(src.projectSlug);
  if (src.originUrl) add(legacyProjectSlugFromOriginUrl(src.originUrl));
  return out;
}
