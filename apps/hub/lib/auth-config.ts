import { join } from 'node:path';
import { STATE_DIR } from '@agentbox/config';

/**
 * Hub auth/profile configuration — a pure env reader with no imports of
 * `node:sqlite` / `pg` / better-auth, so it is safe to import from anywhere:
 * `proxy.ts` (middleware), server components, and the auth factory. The runtime
 * switch is a single env var, `AGENTBOX_HUB_PROFILE`.
 *
 * - localhost: 127.0.0.1 bind, token gate (shared-secret cookie, no login screen).
 * - hetzner:   0.0.0.0 bind, better-auth password, sqlite at ~/.agentbox/hub/auth.db.
 * - vercel:    serverless, better-auth password, Postgres.
 */
export type HubProfile = 'localhost' | 'hetzner' | 'vercel';

export function hubProfile(): HubProfile {
  const raw = process.env.AGENTBOX_HUB_PROFILE;
  if (raw === 'hetzner' || raw === 'vercel') return raw;
  return 'localhost';
}

/**
 * How the hub gates requests:
 * - `token`    localhost — a shared-secret cookie (no login screen). server.ts
 *              generates the token and opens the UI with `?token=`.
 * - `password` hetzner/vercel — better-auth email/password.
 * - `off`      no gate.
 */
export type AuthMode = 'off' | 'token' | 'password';

/** Whether better-auth password login is configured (hetzner/vercel). */
function passwordConfigured(): boolean {
  if (process.env.AGENTBOX_HUB_AUTH === 'off') return false;
  if (process.env.AGENTBOX_HUB_AUTH === 'on') return true;
  // Unset (plain `next start` / vercel): on only if a signing secret exists, so a
  // secretless deploy never serves a login page with no user (a lockout).
  return Boolean(process.env.BETTER_AUTH_SECRET);
}

/**
 * The active gate. `AGENTBOX_HUB_AUTH=off` disables everything. localhost uses
 * the lightweight token gate whenever server.ts has provisioned a token
 * (`AGENTBOX_HUB_TOKEN`); hetzner/vercel use better-auth.
 */
export function authMode(): AuthMode {
  if (process.env.AGENTBOX_HUB_AUTH === 'off') return 'off';
  if (hubProfile() === 'localhost') return process.env.AGENTBOX_HUB_TOKEN ? 'token' : 'off';
  return passwordConfigured() ? 'password' : 'off';
}

/** Whether any gate is active. */
export function authEnabled(): boolean {
  return authMode() !== 'off';
}

/**
 * Session cookies must only be marked `secure` when the hub is reached over
 * https. Hetzner is reached over plain http by default, so a `secure` cookie
 * would never be sent back and login would silently loop. Only vercel (https)
 * gets secure cookies.
 */
export function cookieSecure(): boolean {
  return hubProfile() === 'vercel';
}

/** SQLite auth DB for the hetzner profile (localhost/vercel never create it). */
export const AUTH_DB_PATH = join(STATE_DIR, 'hub', 'auth.db');

/** Shared-secret file for the localhost token gate (auto-managed by server.ts). */
export const AUTH_TOKEN_PATH = join(STATE_DIR, 'hub', 'token');

/** Cookie the localhost token gate sets/checks. */
export const HUB_TOKEN_COOKIE = 'agentbox_hub_token';
