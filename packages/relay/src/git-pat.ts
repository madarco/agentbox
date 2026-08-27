/**
 * Pure GitHub remote-URL helpers: parse a remote, rewrite it to carry a token
 * over HTTPS, and derive the `gh --repo` slug. Shared by the control plane's
 * GitHub-App token leasing (`lease.ts`) and the cloud git.push path.
 */

/** A remote URL split into its parts. `scheme` is null for the scp-like form. */
export interface ParsedGitRemote {
  host: string;
  path: string;
  /** Lowercased URL scheme (`https`, `ssh`, …); null for `git@host:owner/repo`. */
  scheme: string | null;
}

/**
 * Parse any GitHub remote URL (scp-like `git@host:owner/repo`, `ssh://…`, or
 * `https://…`, with or without embedded creds) into `{ host, path, scheme }`.
 * Throws on an unrecognized shape.
 */
export function parseGitRemote(origin: string): ParsedGitRemote {
  const trimmed = origin.trim();
  if (trimmed.length === 0) throw new Error('empty git remote URL');

  // URL form first: scheme://[user@]host[:port]/path. Matching this before the
  // scp branch avoids misreading `https://github.com/...` as scp `https:...`.
  const urlForm = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const scpForm = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
  let host: string;
  let path: string;
  let scheme: string | null;
  if (urlForm) {
    scheme = urlForm[1]!.toLowerCase();
    host = urlForm[2]!;
    path = urlForm[3]!;
  } else if (scpForm && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    scheme = null;
    host = scpForm[1]!;
    path = scpForm[2]!;
  } else {
    throw new Error(`unrecognized git remote URL: ${origin}`);
  }
  return { host, path: path.replace(/^\/+/, ''), scheme };
}

/**
 * Rewrite any GitHub remote URL into an HTTPS URL carrying the PAT as
 * `x-access-token`. Throws on an unrecognized shape.
 */
export function toAuthedHttpsUrl(origin: string, token: string): string {
  const { host, path } = parseGitRemote(origin);
  return `https://x-access-token:${token}@${host}/${path}`;
}

/**
 * Rewrite any GitHub remote URL to plain HTTPS, dropping embedded credentials.
 *
 * For a machine that authenticates git through a credential helper rather than
 * an SSH key — the hub in `hub.gitAuth=gh` mode — an scp-form
 * `git@github.com:owner/repo` origin is unusable: ssh fails at host-key
 * verification (no `known_hosts` entry) before it ever reaches auth, so the
 * helper never gets a say. Same URL over HTTPS is exactly what the helper
 * covers.
 */
export function toHttpsUrl(origin: string): string {
  const { host, path } = parseGitRemote(origin);
  return `https://${host}/${path}`;
}

/**
 * The `[HOST/]OWNER/REPO` slug `gh --repo` expects, derived from a remote URL.
 * github.com is implicit (just `OWNER/REPO`); enterprise hosts are prefixed.
 */
export function repoSlugFromRemote(origin: string): string {
  const { host, path } = parseGitRemote(origin);
  const repo = path.replace(/\.git$/, '');
  return host.toLowerCase() === 'github.com' ? repo : `${host}/${repo}`;
}

/** The gh host a remote points at, or null when it needs no `GH_HOST` hint. */
export interface GhRemoteHost {
  /** Lowercased hostname from the remote — NOT github.com. */
  host: string;
  /**
   * True when `host` could be an `~/.ssh/config` alias (`git@github.com-work:o/r`),
   * i.e. anything but an http(s) URL — there is no aliasing layer between an
   * HTTPS URL and the request it makes, so those hosts are authoritative.
   */
  aliasable: boolean;
}

/**
 * The host `gh` must be pointed at for a remote, or `null` when that is
 * github.com (gh's own default — no hint needed) or the URL isn't a
 * recognizable remote (a local mirror path, junk).
 */
export function ghHostFromRemote(origin: string | undefined): GhRemoteHost | null {
  const trimmed = origin?.trim() ?? '';
  if (trimmed.length === 0) return null;
  let parsed: ParsedGitRemote;
  try {
    parsed = parseGitRemote(trimmed);
  } catch {
    return null;
  }
  const host = parsed.host.toLowerCase();
  if (host === 'github.com') return null;
  return { host, aliasable: parsed.scheme !== 'https' && parsed.scheme !== 'http' };
}
