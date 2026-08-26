import { execa } from 'execa';

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
 */
export interface HostGitToken {
  token: string;
  /** Where it came from — shown to the user before it leaves the machine. */
  source: 'gh' | 'git-credential';
  /** GitHub login the token resolves to, when we can cheaply determine it. */
  login?: string;
}

async function fromGhCli(): Promise<HostGitToken | null> {
  try {
    const r = await execa('gh', ['auth', 'token'], { reject: false, timeout: 15_000 });
    const token = (r.stdout ?? '').trim();
    if (r.exitCode !== 0 || token.length === 0) return null;
    return { token, source: 'gh' };
  } catch {
    return null;
  }
}

async function fromGitCredentialHelper(cwd: string): Promise<HostGitToken | null> {
  try {
    const r = await execa('git', ['credential', 'fill'], {
      cwd,
      input: 'protocol=https\nhost=github.com\n\n',
      reject: false,
      timeout: 15_000,
    });
    if (r.exitCode !== 0) return null;
    const password = /^password=(.*)$/m.exec(r.stdout ?? '')?.[1]?.trim() ?? '';
    if (password.length === 0) return null;
    return { token: password, source: 'git-credential' };
  } catch {
    return null;
  }
}

/** Which GitHub account a token belongs to; undefined when it can't be checked. */
export async function resolveTokenLogin(token: string): Promise<string | undefined> {
  try {
    const res = await fetch('https://api.github.com/user', {
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

/** The first token this machine can offer, or null when it has none. */
export async function findHostGitToken(cwd: string = process.cwd()): Promise<HostGitToken | null> {
  return (await fromGhCli()) ?? (await fromGitCredentialHelper(cwd));
}

/**
 * Scopes a classic token carries, read from the `x-oauth-scopes` response
 * header. Fine-grained PATs and App tokens report none, which is not an error —
 * it just means there is nothing to warn about.
 */
export async function resolveTokenScopes(token: string): Promise<string[]> {
  try {
    const res = await fetch('https://api.github.com/user', {
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
