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
 * - `locked`   a deployed profile with no signing secret: refuse to serve.
 * - `off`      no gate.
 */
export type AuthMode = 'off' | 'token' | 'password' | 'locked';

/**
 * The active gate. `AGENTBOX_HUB_AUTH=off` disables everything. localhost uses
 * the lightweight token gate whenever server.ts has provisioned a token
 * (`AGENTBOX_HUB_TOKEN`); hetzner/vercel use better-auth.
 *
 * A deployed profile with no `BETTER_AUTH_SECRET` is `locked`, not `off`. Without
 * a secret better-auth can neither sign a session nor seed the admin, so the hub
 * would otherwise serve its whole UI and API — boxes, custody, git — to anyone who
 * found the URL. That is reachable today by cancelling the login prompt during
 * `hub setup` / `hub deploy`, and on vercel there is no redeploy path to undo it.
 * Turning auth off is a deliberate act (`AGENTBOX_HUB_AUTH=off`), never a
 * side effect of a missing variable.
 */
export function authMode(): AuthMode {
  if (process.env.AGENTBOX_HUB_AUTH === 'off') return 'off';
  if (hubProfile() === 'localhost') return process.env.AGENTBOX_HUB_TOKEN ? 'token' : 'off';
  return process.env.BETTER_AUTH_SECRET ? 'password' : 'locked';
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

/**
 * SQLite relay-core store (boxes/events/status/prompts/create_jobs) — the
 * hetzner profile's default when no POSTGRES_URL is configured, so the control
 * box needs no database container. Sibling of {@link AUTH_DB_PATH}.
 */
export const STORE_DB_PATH = join(STATE_DIR, 'hub', 'store.db');

/** Shared-secret file for the localhost token gate (auto-managed by server.ts). */
export const AUTH_TOKEN_PATH = join(STATE_DIR, 'hub', 'token');

/** Cookie the localhost token gate sets/checks. */
export const HUB_TOKEN_COOKIE = 'agentbox_hub_token';
