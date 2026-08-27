/**
 * Why a `docker pull` of the box image failed, and how to retry it authenticated.
 *
 * The box image is published to a PUBLIC GHCR repo, so an anonymous pull works —
 * until it doesn't. GHCR rate-limits anonymous pulls per IP, and a machine that
 * has just baked a few times trips it. `docker pull` then exits non-zero and the
 * caller falls back to a ~10-minute local build of an image that was sitting in
 * the registry all along. Worse, the old code returned a bare boolean, so a
 * rate-limit, a 401 and a genuinely-unpublished tag were indistinguishable and
 * none of them reached the log.
 *
 * So: classify the failure, and when it is a throttle/auth problem on GHCR,
 * borrow the host's `gh` token and retry once.
 *
 * The load-bearing subtlety is the SCOPE. `gh auth token` returns whatever the
 * user's `gh auth login` negotiated — by default `repo`, `read:org`, `gist`,
 * `workflow` and *not* `read:packages`. Logging in to GHCR with such a token is
 * actively worse than staying anonymous: the registry then evaluates an
 * identity that lacks package-read and answers 403, turning a pull that would
 * have succeeded into one that cannot. So we check the scope first and skip the
 * login when it is absent, telling the user the one command that fixes it.
 */
import { execa } from 'execa';

/** GHCR is the only registry we know how to authenticate from `gh`. */
export const GHCR_HOST = 'ghcr.io';

/** The scope GHCR requires to read a package, public or not. */
const PACKAGE_READ_SCOPE = 'read:packages';

export type PullFailureKind =
  /** GHCR throttled us — the tag exists and an authenticated retry should work. */
  | 'rate-limit'
  /** Credentials rejected or absent where required. */
  | 'unauthorized'
  /** The tag genuinely is not published — a local build is the correct answer. */
  | 'not-found'
  /** DNS / TCP / TLS — nothing to do with the tag. */
  | 'network'
  | 'unknown';

export interface PullFailure {
  kind: PullFailureKind;
  /** The most useful line of docker's own stderr, for the log. */
  detail: string;
}

/**
 * Map `docker pull` stderr onto a {@link PullFailureKind}. Substring matching on
 * docker/registry error text rather than exit codes, which are always 1.
 */
export function classifyPullFailure(stderr: string): PullFailure {
  const text = stderr.toLowerCase();
  const detail = lastMeaningfulLine(stderr);
  // Order matters: a throttle response also says "unauthorized" on some
  // registries, and it is the throttle that decides whether a retry can help.
  if (
    text.includes('toomanyrequests') ||
    text.includes('too many requests') ||
    text.includes('429')
  ) {
    return { kind: 'rate-limit', detail };
  }
  if (
    text.includes('manifest unknown') ||
    text.includes('not found') ||
    text.includes('404') ||
    text.includes('no such manifest')
  ) {
    return { kind: 'not-found', detail };
  }
  if (
    text.includes('unauthorized') ||
    text.includes('authentication required') ||
    text.includes('denied') ||
    text.includes('403')
  ) {
    return { kind: 'unauthorized', detail };
  }
  if (
    text.includes('dial tcp') ||
    text.includes('no such host') ||
    text.includes('timeout') ||
    text.includes('temporary failure in name resolution') ||
    text.includes('connection refused') ||
    text.includes('tls handshake')
  ) {
    return { kind: 'network', detail };
  }
  return { kind: 'unknown', detail };
}

/** The last non-empty stderr line, trimmed — docker puts the real error last. */
function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : 'no error output from docker';
}

/** Only a throttle or a credential problem can be improved by authenticating. */
export function isAuthRetryable(kind: PullFailureKind): boolean {
  return kind === 'rate-limit' || kind === 'unauthorized';
}

/** True when `target` lives on GHCR, the only host we can log into from `gh`. */
export function isGhcrTarget(target: string): boolean {
  return target.startsWith(`${GHCR_HOST}/`);
}

export interface GhcrLoginResult {
  ok: boolean;
  /** Why we did not (or could not) log in — always safe to show the user. */
  reason?: string;
}

interface Runner {
  (
    file: string,
    args: string[],
    opts?: { input?: string },
  ): Promise<{
    exitCode: number | undefined;
    stdout: string;
    stderr: string;
  }>;
}

const realRunner: Runner = async (file, args, opts) => {
  const r = await execa(file, args, {
    reject: false,
    timeout: 30_000,
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
  });
  return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/**
 * Log the local docker engine into GHCR using the host's `gh` token, so the
 * retry is authenticated (and rate-limited far more generously).
 *
 * Refuses rather than risks it when the token lacks `read:packages` — see the
 * module comment. `fetchScopes` is injected so this is testable without network.
 */
export async function loginToGhcrWithGh(
  opts: {
    run?: Runner;
    fetchScopes?: (token: string) => Promise<string[]>;
  } = {},
): Promise<GhcrLoginResult> {
  const run = opts.run ?? realRunner;

  // Pinned to github.com: GHCR only accepts github.com tokens, while a bare
  // `gh auth token` returns the DEFAULT host's token — which for someone whose
  // gh is set up against GitHub Enterprise Server is an enterprise credential
  // we would then hand to ghcr.io.
  const tok = await run('gh', ['auth', 'token', '--hostname', 'github.com']);
  const token = tok.stdout.trim();
  if (tok.exitCode !== 0 || token.length === 0) {
    return {
      ok: false,
      reason:
        'no github.com `gh` token on this machine (run `gh auth login --hostname github.com`)',
    };
  }

  const scopes = await (opts.fetchScopes ?? fetchTokenScopes)(token);
  // An empty list means we could not read the header (offline, or a fine-grained
  // token that reports no classic scopes). Attempting the login is then the
  // lesser evil: a fine-grained PAT with package-read is a normal setup, and a
  // failed login leaves us exactly where we already are.
  if (scopes.length > 0 && !scopes.includes(PACKAGE_READ_SCOPE)) {
    return {
      ok: false,
      reason:
        `your \`gh\` token lacks the ${PACKAGE_READ_SCOPE} scope, so authenticating would be ` +
        `rejected by ${GHCR_HOST}. Add it with: gh auth refresh -h github.com -s ${PACKAGE_READ_SCOPE}`,
    };
  }

  // GHCR ignores the username when the password is a valid token, but docker
  // requires a non-empty one.
  const login = await run('docker', ['login', GHCR_HOST, '-u', 'agentbox', '--password-stdin'], {
    input: token,
  });
  if (login.exitCode !== 0) {
    return { ok: false, reason: lastMeaningfulLine(login.stderr || login.stdout) };
  }
  return { ok: true };
}

/** Classic OAuth scopes for `token`, from GitHub's `x-oauth-scopes` header. */
async function fetchTokenScopes(token: string): Promise<string[]> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agentbox',
      },
      signal: AbortSignal.timeout(10_000),
    });
    return (res.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}
