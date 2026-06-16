import { createSign } from 'node:crypto';

/**
 * GitHub App token leasing for the hosted control plane.
 *
 * The control plane holds only the App's private key + id — never a long-lived
 * PAT and never a box's repo. On an approved push it mints a short-lived
 * **installation access token** scoped to the SINGLE box repo (minimal perms)
 * and hands it to the box, which pushes to GitHub directly. GitHub installation
 * tokens always expire in ≤1h and are repo-scoped, so a compromised box yields
 * at most a 1h single-repo credential. The token is never persisted (in-memory
 * cache only; re-minted on a cold start — two cheap API calls).
 *
 * `fetch` (Node 20+) is used directly — no SDK dependency.
 */

export interface GitHubAppConfig {
  appId: string;
  privateKeyPem: string;
  /** API base; defaults to https://api.github.com (override for GHES). */
  apiBaseUrl?: string;
}

export interface LeasedToken {
  token: string;
  /** ISO-8601 expiry as returned by GitHub. */
  expiresAt: string;
}

/**
 * Load the App config from the environment, or null when not configured.
 * `GITHUB_APP_PRIVATE_KEY` may be a raw PEM or base64-encoded PEM (env-friendly).
 */
export function loadGitHubAppConfig(): GitHubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID;
  let key = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !key) return null;
  if (!key.includes('BEGIN')) {
    try {
      key = Buffer.from(key, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  const apiBaseUrl = process.env.GITHUB_API_URL || undefined;
  return { appId, privateKeyPem: key, apiBaseUrl };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Mint the App JWT (RS256). `exp` is well under GitHub's 10-minute ceiling;
 * `iat` is backdated 60s to tolerate clock skew. Exported for unit testing.
 */
export function appJwt(cfg: GitHubAppConfig, nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: cfg.appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(cfg.privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

type FetchLike = typeof fetch;

export interface GitHubAppLeaserOptions {
  /** Inject a fetch impl (tests). Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Inject a clock (tests). Defaults to Date.now. */
  now?: () => number;
}

interface CacheEntry {
  token: string;
  expiresAt: string;
  expiresAtMs: number;
}

const RENEW_BEFORE_MS = 5 * 60 * 1000; // re-mint when <5 min of life remains

/**
 * Leases (and caches) repo-scoped installation tokens. One instance per relay
 * server. The cache key is `owner/repo`; a token is reused until it is within
 * RENEW_BEFORE_MS of expiry.
 */
export class GitHubAppLeaser {
  private readonly cfg: GitHubAppConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly apiBase: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly installationIds = new Map<string, number>();

  constructor(cfg: GitHubAppConfig, opts: GitHubAppLeaserOptions = {}) {
    this.cfg = cfg;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.apiBase = (cfg.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  }

  private headers(jwt: string): Record<string, string> {
    return {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agentbox-relay',
    };
  }

  /**
   * Resolve the installation id for `owner/repo`, or null when the App is not
   * installed on it (404). Caches positive lookups. Non-404 errors throw.
   */
  private async lookupInstallationId(owner: string, repo: string): Promise<number | null> {
    const key = `${owner}/${repo}`;
    const cached = this.installationIds.get(key);
    if (cached !== undefined) return cached;
    const jwt = appJwt(this.cfg, this.now());
    const res = await this.fetchImpl(`${this.apiBase}/repos/${owner}/${repo}/installation`, {
      headers: this.headers(jwt),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GET installation for ${key} → ${String(res.status)}`);
    }
    const body = (await res.json()) as { id?: number };
    if (typeof body.id !== 'number') throw new Error('installation response missing id');
    this.installationIds.set(key, body.id);
    return body.id;
  }

  private async installationId(owner: string, repo: string): Promise<number> {
    const id = await this.lookupInstallationId(owner, repo);
    if (id === null) throw new Error(`GitHub App is not installed on ${owner}/${repo}`);
    return id;
  }

  /** Whether the App is installed on `owner/repo` — no token is minted. */
  async isRepoInstalled(owner: string, repo: string): Promise<boolean> {
    return (await this.lookupInstallationId(owner, repo)) !== null;
  }

  /**
   * Mint (or return a cached) installation token scoped to the single repo with
   * `contents: write` + `pull_requests: write`. Throws on any GitHub error.
   */
  async leaseRepoToken(owner: string, repo: string): Promise<LeasedToken> {
    const key = `${owner}/${repo}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs - this.now() > RENEW_BEFORE_MS) {
      return { token: cached.token, expiresAt: cached.expiresAt };
    }
    const id = await this.installationId(owner, repo);
    const jwt = appJwt(this.cfg, this.now());
    const res = await this.fetchImpl(`${this.apiBase}/app/installations/${String(id)}/access_tokens`, {
      method: 'POST',
      headers: { ...this.headers(jwt), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repositories: [repo],
        permissions: { contents: 'write', pull_requests: 'write' },
      }),
    });
    if (!res.ok) {
      throw new Error(`failed to mint installation token for ${key} (→ ${String(res.status)})`);
    }
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token || !body.expires_at) throw new Error('access_tokens response missing token/expires_at');
    this.cache.set(key, {
      token: body.token,
      expiresAt: body.expires_at,
      expiresAtMs: Date.parse(body.expires_at),
    });
    return { token: body.token, expiresAt: body.expires_at };
  }
}
