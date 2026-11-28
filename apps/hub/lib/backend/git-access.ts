// How this hub reaches GitHub, for the Settings "Git access" card
// (`GET /api/v1/settings/git-access`). Three shapes, decided by where the hub
// runs and what it was deployed with:
//
// - `local`: the hub on the user's PC. Boxes hold no git credential; the relay
//   runs the real `git push` / `gh` here with the user's own login, after an
//   approval.
// - `gh` (control box, `hub.gitAuth=gh`): `hub setup` copied a GitHub token into
//   the hub's `secrets.env`; the hub pushes with it (see `lib/git-auth.ts`).
// - `app` (control box, `hub.gitAuth=app`): the hub holds a GitHub App key and
//   leases 1-hour single-repo tokens (`GitHubAppLeaser` in @agentbox/relay).
//
// Every remote lookup is best-effort and cached: the card must render even when
// `gh` is missing or GitHub is down. The token itself never leaves this module.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { loadEffectiveConfig } from '@agentbox/config';
import { appJwt, loadGitHubAppConfig, type GitHubAppConfig } from '@agentbox/relay';
import { isControlBoxProcess } from '@agentbox/sandbox-core';
import { loadHubGitToken } from '../git-auth';
import type {
  GitAccessApp,
  GitAccessBackend,
  GitAccessInstallation,
  GitAccessView,
} from '../boxes/backend-types';

/** `gh api user`: the login, or why there is none. `rejected` = GitHub said 401. */
export type GhUserResult =
  | { ok: true; login: string }
  | { ok: false; rejected: boolean; error: string };

export type GhUserLookup = (token: string | undefined) => Promise<GhUserResult>;
export type AppLookup = (cfg: GitHubAppConfig) => Promise<GitAccessApp>;

export interface GitAccessDeps {
  /** True on a deployed control box (`AGENTBOX_HUB_WORKER=on`). */
  isControlBox: () => boolean;
  /** `hub.gitAuth` from this machine's config, when readable. */
  configuredMode: () => Promise<'gh' | 'app' | undefined>;
  /** The hub's stored GitHub token (`GH_TOKEN` / `GITHUB_TOKEN`), if any. */
  token: () => string | undefined;
  appConfig: () => GitHubAppConfig | null;
  /** Host a `gh` login or token is for (`GH_HOST`, else github.com). */
  ghHost: () => string;
  /** Host the App API calls go to (`GITHUB_API_URL`, else github.com). */
  apiHost: (cfg: GitHubAppConfig | null) => string;
  ghUser: GhUserLookup;
  appInfo: AppLookup;
  now: () => number;
}

const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 60_000;

export const APP_KEY_MISSING =
  'hub.gitAuth is app, but GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are not set on this hub';

/**
 * Which credential boxes push with. It follows `hub.gitAuth` exactly, the same
 * rule `bootstrap-launch.ts` applies (`(hubGitAuth ?? 'gh') === 'app'` decides
 * whether a box leases), so an App configured beside a `gh` hub does not make
 * it an App hub.
 */
export function resolveGitAccessMode(input: {
  controlBox: boolean;
  configured: 'gh' | 'app' | undefined;
}): GitAccessView['mode'] {
  if (!input.controlBox) return 'local';
  return input.configured === 'app' ? 'app' : 'gh';
}

/** A cache key that changes with the token but cannot be reversed into it. */
function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createGitAccessBackend(deps: Partial<GitAccessDeps> = {}): GitAccessBackend {
  const d: GitAccessDeps = { ...defaultGitAccessDeps(), ...deps };
  // Entries hold the promise, so concurrent misses share one lookup. `ttl` is
  // set once it settles; until then the entry is always a hit.
  const cache = new Map<string, { at: number; ttl?: number; value: Promise<GitAccessView> }>();
  // `hub.gitAuth` is deploy intent read once at boot by server.ts; a running hub
  // does not change behavior when it is edited, so neither does the card.
  let configured: Promise<'gh' | 'app' | undefined> | undefined;

  const cached = (
    key: string,
    compute: () => Promise<{ value: GitAccessView; ok: boolean }>,
  ): Promise<GitAccessView> => {
    const hit = cache.get(key);
    if (hit && (hit.ttl === undefined || d.now() - hit.at < hit.ttl)) return hit.value;
    const entry: { at: number; ttl?: number; value: Promise<GitAccessView> } = {
      at: d.now(),
      value: compute().then(({ value, ok }) => {
        entry.at = d.now();
        entry.ttl = ok ? OK_TTL_MS : FAIL_TTL_MS;
        return value;
      }),
    };
    cache.set(key, entry);
    return entry.value;
  };

  const ghUser = (token: string | undefined): Promise<GhUserResult> =>
    d
      .ghUser(token)
      .catch((e: unknown): GhUserResult => ({ ok: false, rejected: false, error: messageOf(e) }));

  return {
    async getGitAccess(): Promise<GitAccessView> {
      const controlBox = d.isControlBox();
      if (controlBox) configured ??= d.configuredMode().catch(() => undefined);
      const mode = resolveGitAccessMode({
        controlBox,
        configured: controlBox ? await configured : undefined,
      });

      if (mode === 'local') {
        const host = d.ghHost();
        return cached('local', async () => {
          const r = await ghUser(undefined);
          // No `gh` login on the PC is a normal state here, not an error to show.
          return { value: { mode, host, ...(r.ok ? { login: r.login } : {}) }, ok: r.ok };
        });
      }

      const appCfg = d.appConfig();
      if (mode === 'app') {
        const host = d.apiHost(appCfg);
        if (!appCfg) return { mode, host, error: APP_KEY_MISSING };
        return cached(`app:${appCfg.appId}`, async () => {
          try {
            return { value: { mode, host, app: await d.appInfo(appCfg) }, ok: true };
          } catch (e) {
            return {
              value: { mode, host, app: { id: appCfg.appId }, error: messageOf(e) },
              ok: false,
            };
          }
        });
      }

      const host = d.ghHost();
      const token = d.token();
      // The create worker clones through an App whenever one is configured
      // (`leaseRemoteUrl` in hub-worker.ts), even on a `gh` hub.
      const cloneApp = appCfg ? { app: { id: appCfg.appId } } : {};
      if (!token) return { mode, host, tokenPresent: false, ...cloneApp };
      return cached(`gh:${fingerprint(token)}:${appCfg?.appId ?? ''}`, async () => {
        const r = await ghUser(token);
        const value: GitAccessView = r.ok
          ? { mode, host, tokenPresent: true, login: r.login, ...cloneApp }
          : {
              mode,
              host,
              tokenPresent: true,
              ...(r.rejected ? { tokenRejected: true } : {}),
              error: r.error,
              ...cloneApp,
            };
        return { value, ok: r.ok };
      });
    },
  };
}

/** True when `gh` (or the API) answered 401: the token exists but GitHub refuses it. */
export function isRejectedTokenError(text: string): boolean {
  return /HTTP 401|Bad credentials/i.test(text);
}

/** First meaningful line of a `gh` failure, with anything token-shaped masked. */
function errorLine(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? 'gh api user failed';
  return line.replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***').slice(0, 300);
}

/**
 * `gh api user --jq .login`. With a token, it is passed as `GH_TOKEN` so the
 * answer is about the hub's credential and nothing else; without one, `gh` uses
 * whatever login this machine has.
 */
export function ghUserViaCli(
  run: (args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string }> = execGh,
): GhUserLookup {
  return async (token) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1' };
    if (token) {
      env.GH_TOKEN = token;
      delete env.GITHUB_TOKEN;
    }
    try {
      const { stdout } = await run(['api', 'user', '--jq', '.login'], env);
      const login = stdout.trim();
      if (!login) return { ok: false, rejected: false, error: 'gh api user returned no login' };
      return { ok: true, login };
    } catch (e) {
      const err = e as { stderr?: unknown; message?: unknown; code?: unknown };
      if (err.code === 'ENOENT')
        return { ok: false, rejected: false, error: 'gh is not installed' };
      const text = `${typeof err.stderr === 'string' ? err.stderr : ''}\n${
        typeof err.message === 'string' ? err.message : ''
      }`;
      return { ok: false, rejected: isRejectedTokenError(text), error: errorLine(text) };
    }
  };
}

function execGh(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { env, timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout });
    });
  });
}

type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

const FETCH_TIMEOUT_MS = 10_000;
const MAX_INSTALLATION_PAGES = 10;

/**
 * The App's name and where it is installed: `GET /app` and
 * `GET /app/installations`, both with the App JWT (no installation token is
 * minted). A failed installations read keeps the identity. Each call is capped
 * at 10s, so a stalled GitHub cannot hang the route.
 */
export function appInfoViaApi(fetchImpl: FetchLike = fetch, now: () => number = Date.now) {
  return async (cfg: GitHubAppConfig): Promise<GitAccessApp> => {
    const base = (cfg.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    const headers = {
      Authorization: `Bearer ${appJwt(cfg, now())}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agentbox-hub',
    };
    const appRes = await fetchImpl(`${base}/app`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!appRes.ok) throw new Error(`GET /app → ${String(appRes.status)}`);
    const app = (await appRes.json()) as {
      name?: string;
      slug?: string;
      html_url?: string;
      owner?: { login?: string };
    };
    const out: GitAccessApp = {
      id: cfg.appId,
      ...(app.name ? { name: app.name } : {}),
      ...(app.slug ? { slug: app.slug } : {}),
      ...(app.html_url ? { url: app.html_url } : {}),
      ...(app.owner?.login ? { owner: app.owner.login } : {}),
    };
    // Best-effort: any failure here keeps the identity read above.
    try {
      const installations: GitAccessInstallation[] = [];
      for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
        const res = await fetchImpl(`${base}/app/installations?per_page=100&page=${String(page)}`, {
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`GET /app/installations → ${String(res.status)}`);
        const list: unknown = await res.json();
        if (!Array.isArray(list)) throw new Error('GET /app/installations: not a list');
        for (const i of list as {
          account?: { login?: unknown };
          repository_selection?: unknown;
        }[]) {
          if (typeof i.account?.login !== 'string') continue;
          installations.push({
            account: i.account.login,
            repositories: i.repository_selection === 'all' ? 'all' : 'selected',
          });
        }
        if (list.length < 100) break;
      }
      out.installations = installations;
    } catch {
      // Leave `installations` unset: the card says it could not read them.
    }
    return out;
  };
}

/** `https://ghe.corp/api/v3` -> `ghe.corp`; unset or unparsable -> `github.com`. */
export function apiHostOf(apiBaseUrl: string | undefined): string {
  if (!apiBaseUrl) return 'github.com';
  try {
    const h = new URL(apiBaseUrl).hostname;
    return h === 'api.github.com' ? 'github.com' : h;
  } catch {
    return 'github.com';
  }
}

export function defaultGitAccessDeps(): GitAccessDeps {
  return {
    isControlBox: () => isControlBoxProcess(),
    configuredMode: () => loadEffectiveConfig(homedir()).then((c) => c.effective.hub.gitAuth),
    token: () => loadHubGitToken(),
    appConfig: () => loadGitHubAppConfig(),
    ghHost: () => process.env.GH_HOST?.trim() || 'github.com',
    apiHost: (cfg) => apiHostOf(cfg?.apiBaseUrl ?? process.env.GITHUB_API_URL),
    ghUser: ghUserViaCli(),
    appInfo: appInfoViaApi(),
    now: Date.now,
  };
}
