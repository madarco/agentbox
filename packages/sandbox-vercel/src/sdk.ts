/**
 * Thin loader around `@vercel/sandbox`. Resolves the auth credentials once and
 * threads them into every SDK call.
 *
 * Two auth modes (mirrors the SDK's own precedence):
 *   - OIDC: `VERCEL_OIDC_TOKEN` in env → the SDK reads it itself, so we pass
 *     no explicit credentials (`resolveCredentials()` returns `{}`).
 *   - Access token: `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` →
 *     passed explicitly as `{ token, teamId, projectId }` on each call, since
 *     the SDK does NOT read those from env automatically.
 */

import { ensureVercelEnvLoaded } from './env-loader.js';

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

/** True when either auth mode is configured. Used by the credential gate. */
export function hasUsableCredentials(): boolean {
  ensureVercelEnvLoaded();
  if (process.env.VERCEL_OIDC_TOKEN) return true;
  return Boolean(
    process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID,
  );
}

// Re-export the SDK surface we use so the rest of the package imports from one
// place (and tests can mock `./sdk.js` instead of the package).
export { Sandbox, Snapshot } from '@vercel/sandbox';
export type { Sandbox as SandboxType } from '@vercel/sandbox';
