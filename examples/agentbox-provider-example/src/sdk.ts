/**
 * Thin loader around `@vercel/sandbox`. Resolves the auth credentials once and
 * threads them into every SDK call.
 *
 * Three auth modes (in precedence order):
 *   - OIDC: `VERCEL_OIDC_TOKEN` in env → decode the JWT for owner/project and
 *     pass `{ token, teamId, projectId }` explicitly.
 *   - CLI-login: `VERCEL_AUTH_SOURCE=cli` → read the live OAuth access token
 *     from the Vercel CLI's own store (`auth.json`) and the cached team/project
 *     ids from `secrets.env`. The token is never copied to `secrets.env`; the
 *     CLI store is the self-refreshing source of truth. `ensureFreshCredentials`
 *     refreshes it (via the `sbx` CLI) before use when it's near expiry.
 *   - Access token: `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` →
 *     passed explicitly as `{ token, teamId, projectId }` on each call, since
 *     the SDK does NOT read those from env automatically.
 */

import { ensureVercelEnvLoaded } from './env-loader.js';
import { isNearExpiry, readCliAuth, readCliCurrentTeam } from './cli-store.js';
import { detectSbx, refreshSbxToken } from './sbx-cli.js';

export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

/**
 * Resolve the credentials to thread into SDK calls. Throws when nothing is
 * configured (or an OIDC token has expired) so callers get a clear, actionable
 * error instead of an opaque SDK auth failure.
 *
 * For OIDC we do NOT return `{}` and let the SDK read the env var: the SDK's
 * env-OIDC path (`@vercel/oidc`) tries to *refresh* the token via the Vercel
 * CLI's `.vercel/project.json` + cached auth, which an agentbox box doesn't
 * have, so it fails with "Could not get credentials from OIDC context". Instead
 * we decode the OIDC JWT — which embeds `owner_id` (teamId) and `project_id` —
 * and pass `{ token, teamId, projectId }` explicitly, which uses the SDK's
 * direct-credentials path (the OIDC token is itself a valid API bearer).
 */
export function resolveCredentials(): VercelCredentials {
  ensureVercelEnvLoaded();
  const oidc = process.env.VERCEL_OIDC_TOKEN;
  if (oidc) {
    const claims = decodeOidcClaims(oidc);
    if (!claims) {
      throw new Error(
        'VERCEL_OIDC_TOKEN is set but could not be decoded (not a valid Vercel OIDC JWT). ' +
          'Re-run `vercel env pull`, or use the VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID trio.',
      );
    }
    if (claims.exp !== undefined && claims.exp * 1000 < Date.now()) {
      throw new Error(
        'VERCEL_OIDC_TOKEN has expired (Vercel dev OIDC tokens last ~12h). ' +
          'Re-run `vercel env pull` to refresh it, then retry.',
      );
    }
    return { token: oidc, teamId: claims.teamId, projectId: claims.projectId };
  }
  if (process.env.VERCEL_AUTH_SOURCE === 'cli') {
    const auth = readCliAuth();
    if (!auth) {
      throw new Error(
        'Vercel CLI session not found — run `agentbox vercel login` (or `sbx login`) to sign in again.',
      );
    }
    const teamId = process.env.VERCEL_TEAM_ID ?? readCliCurrentTeam() ?? undefined;
    const projectId = process.env.VERCEL_PROJECT_ID;
    if (!teamId || !projectId) {
      throw new Error(
        'Vercel CLI auth is missing the team/project id — re-run `agentbox vercel login`.',
      );
    }
    // Live token straight from the CLI store; nothing cached on disk.
    return { token: auth.token, teamId, projectId };
  }
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) return { token, teamId, projectId };
  throw new Error(
    'Vercel credentials not configured.\n' +
      'Either run `vercel link && vercel env pull` to get a VERCEL_OIDC_TOKEN, ' +
      'or set VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID ' +
      '(see `agentbox vercel login`).',
  );
}

interface OidcClaims {
  teamId: string;
  projectId: string;
  exp?: number;
}

/** Decode the `owner_id`/`project_id`/`exp` claims from a Vercel OIDC JWT. */
function decodeOidcClaims(token: string): OidcClaims | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      owner_id?: unknown;
      project_id?: unknown;
      exp?: unknown;
    };
    if (typeof payload.owner_id !== 'string' || typeof payload.project_id !== 'string') return null;
    return {
      teamId: payload.owner_id,
      projectId: payload.project_id,
      exp: typeof payload.exp === 'number' ? payload.exp : undefined,
    };
  } catch {
    return null;
  }
}

/** True when any auth mode is configured. Used by the credential gate. */
export function hasUsableCredentials(): boolean {
  ensureVercelEnvLoaded();
  if (process.env.VERCEL_OIDC_TOKEN) return true;
  if (
    process.env.VERCEL_AUTH_SOURCE === 'cli' &&
    process.env.VERCEL_TEAM_ID &&
    process.env.VERCEL_PROJECT_ID &&
    readCliAuth()
  ) {
    return true;
  }
  return Boolean(
    process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID,
  );
}

/**
 * Refresh the CLI-login access token before use when it's near expiry. No-op
 * for the OIDC and access-token modes (nothing to refresh). For CLI mode: if the
 * live token in the CLI store is within the safety window, run a cheap `sbx`
 * read command, which makes the CLI rotate its own token from the stored refresh
 * token, then re-read `secrets.env`. Throws an actionable error when the CLI is
 * gone or the refresh fails (e.g. the refresh token itself expired).
 *
 * Call this once at the top of each backend operation, BEFORE the (sync)
 * `resolveCredentials()` reads the token. An in-process single-flight collapses
 * concurrent ops onto one refresh; cross-process races are harmless (the CLI
 * writes its store atomically and a fresh-token refresh is a no-op).
 */
let inflightRefresh: Promise<void> | null = null;

export function ensureFreshCredentials(): Promise<void> {
  ensureVercelEnvLoaded();
  if (process.env.VERCEL_AUTH_SOURCE !== 'cli') return Promise.resolve();
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = refreshCliToken().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

async function refreshCliToken(): Promise<void> {
  const auth = readCliAuth();
  if (!auth) return; // resolveCredentials() will throw the clear "logged out" error
  if (!isNearExpiry(auth)) return; // still valid — no work

  const det = await detectSbx();
  if (!det.installed || !det.bin) {
    throw new Error(
      'Vercel access token is near expiry and the `sandbox` CLI is no longer installed — ' +
        'reinstall it (`npm install -g sandbox`) or run `agentbox vercel login`.',
    );
  }
  const ok = await refreshSbxToken(det.bin);
  if (!ok) {
    throw new Error(
      'Vercel token refresh failed — run `agentbox vercel login` (the refresh token may have expired).',
    );
  }
  // The token lives in the CLI store, not secrets.env — refreshSbxToken rotated
  // auth.json in place, so the next readCliAuth() returns the fresh token.
  const fresh = readCliAuth();
  if (!fresh || isNearExpiry(fresh, 0)) {
    throw new Error(
      'Vercel token is still stale after a refresh attempt — run `agentbox vercel login`.',
    );
  }
}

// Re-export the SDK surface we use so the rest of the package imports from one
// place (and tests can mock `./sdk.js` instead of the package).
export { Sandbox, Snapshot } from '@vercel/sandbox';
export type { Sandbox as SandboxType } from '@vercel/sandbox';
