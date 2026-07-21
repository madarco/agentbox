/**
 * Pure GitHub remote-URL helpers: parse a remote, rewrite it to carry a token
 * over HTTPS, and derive the `gh --repo` slug. Shared by the control plane's
 * GitHub-App token leasing (`lease.ts`) and the cloud git.push path.
 */

/**
 * Parse any GitHub remote URL (scp-like `git@host:owner/repo`, `ssh://…`, or
 * `https://…`, with or without embedded creds) into `{ host, path }`. Throws on
 * an unrecognized shape.
 */
export function parseGitRemote(origin: string): { host: string; path: string } {
  const trimmed = origin.trim();
  if (trimmed.length === 0) throw new Error('empty git remote URL');

  // URL form first: scheme://[user@]host[:port]/path. Matching this before the
  // scp branch avoids misreading `https://github.com/...` as scp `https:...`.
  const urlForm = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const scpForm = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
  let host: string;
  let path: string;
  if (urlForm) {
    host = urlForm[1]!;
    path = urlForm[2]!;
  } else if (scpForm && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    host = scpForm[1]!;
    path = scpForm[2]!;
  } else {
    throw new Error(`unrecognized git remote URL: ${origin}`);
  }
  return { host, path: path.replace(/^\/+/, '') };
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
 * The `[HOST/]OWNER/REPO` slug `gh --repo` expects, derived from a remote URL.
 * github.com is implicit (just `OWNER/REPO`); enterprise hosts are prefixed.
 */
export function repoSlugFromRemote(origin: string): string {
  const { host, path } = parseGitRemote(origin);
  const repo = path.replace(/\.git$/, '');
  return host.toLowerCase() === 'github.com' ? repo : `${host}/${repo}`;
}
