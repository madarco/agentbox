import { execa } from 'execa';
import { resolveOriginGitHost } from '../lib/git-host.js';

/**
 * Find a GitHub token on THIS machine to hand to a control box (`hub.gitAuth=gh`).
 *
 * The control box does the git work on a box's behalf — clone for the create
 * worker, the real `git push` at the end of the relay's bundle path — so it
 * needs a credential of its own. The point of this mode is that the credential
 * is one you already have and can create yourself: no GitHub App to install, no
 * org admin to ask.
 *
 * Order, most-specific first:
 *   1. `gh auth token` — the common case, and the one that needs no prompting.
 *   2. git's credential helper (osxkeychain / store / manager) via
 *      `git credential fill`, which is how a user who authenticates git without
 *      `gh` still has a usable token.
 *
 * Deliberately NOT consulted: an ambient `GH_TOKEN`/`GITHUB_TOKEN` in the
 * environment. A developer exporting one for a shell session would otherwise
 * have it silently promoted to a long-lived server credential without ever being
 * shown what was taken.
 *
 * Both sources are asked about the host the project's `origin` actually points
 * at, so a GitHub Enterprise Server repo gets its enterprise credential rather
 * than whichever host `gh` happens to default to.
 */
export interface HostGitToken {
  token: string;
  /** Where it came from — shown to the user before it leaves the machine. */
  source: 'gh' | 'git-credential';
  /** The GitHub host it authenticates against (github.com, or a GHES instance). */
  host: string;
  /** GitHub login the token resolves to, when we can cheaply determine it. */
  login?: string;
}

async function fromGhCli(host: string): Promise<HostGitToken | null> {
  try {
    const r = await execa('gh', ['auth', 'token', '--hostname', host], {
      reject: false,
      timeout: 15_000,
    });
    const token = (r.stdout ?? '').trim();
    if (r.exitCode !== 0 || token.length === 0) return null;
    return { token, source: 'gh', host };
  } catch {
    return null;
  }
}

async function fromGitCredentialHelper(cwd: string, host: string): Promise<HostGitToken | null> {
  try {
    const r = await execa('git', ['credential', 'fill'], {
      cwd,
      input: `protocol=https\nhost=${host}\n\n`,
      reject: false,
      timeout: 15_000,
    });
    if (r.exitCode !== 0) return null;
    const password = /^password=(.*)$/m.exec(r.stdout ?? '')?.[1]?.trim() ?? '';
    if (password.length === 0) return null;
    return { token: password, source: 'git-credential', host };
  } catch {
    return null;
  }
}

/**
 * REST base for a GitHub host: github.com and Enterprise Cloud tenancy hosts
 * answer on `api.<host>`, self-hosted GHES on `<host>/api/v3`.
 */
export function githubApiBase(host: string): string {
  const h = host.toLowerCase();
  if (h === 'github.com' || h.endsWith('.ghe.com')) return `https://api.${h}`;
  return `https://${h}/api/v3`;
}

/** Which GitHub account a token belongs to; undefined when it can't be checked. */
export async function resolveTokenLogin(
  token: string,
  host = 'github.com',
): Promise<string | undefined> {
  try {
    const res = await fetch(`${githubApiBase(host)}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agentbox',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { login?: unknown };
    return typeof body.login === 'string' ? body.login : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The GitHub host a checkout's `origin` points at — github.com unless the repo
 * lives on a GitHub Enterprise Server instance. ssh aliases are expanded (see
 * `resolveOriginGitHost`), so `git@github.com-work:o/r` asks github.com for its
 * credential rather than a host that doesn't exist. Falls back to github.com
 * when there is no origin to read (a fresh dir, a non-git cwd).
 */
export async function originGitHost(cwd: string): Promise<string> {
  try {
    const r = await execa('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      reject: false,
      timeout: 15_000,
    });
    if (r.exitCode !== 0) return 'github.com';
    return await resolveOriginGitHost((r.stdout ?? '').trim());
  } catch {
    return 'github.com';
  }
}

/** The first token this machine can offer for `cwd`'s origin host, or null. */
export async function findHostGitToken(cwd: string = process.cwd()): Promise<HostGitToken | null> {
  const host = await originGitHost(cwd);
  return (await fromGhCli(host)) ?? (await fromGitCredentialHelper(cwd, host));
}

/**
 * Scopes a classic token carries, read from the `x-oauth-scopes` response
 * header. Fine-grained PATs and App tokens report none, which is not an error —
 * it just means there is nothing to warn about.
 */
export async function resolveTokenScopes(token: string, host = 'github.com'): Promise<string[]> {
  try {
    const res = await fetch(`${githubApiBase(host)}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agentbox',
      },
      signal: AbortSignal.timeout(10_000),
    });
    const raw = res.headers.get('x-oauth-scopes') ?? '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/** Scopes worth flagging: far beyond what the hub needs to clone and push. */
export const OVERBROAD_SCOPES = ['admin:org', 'delete_repo', 'admin:enterprise'] as const;

export function overbroadScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => (OVERBROAD_SCOPES as readonly string[]).includes(s));
}
