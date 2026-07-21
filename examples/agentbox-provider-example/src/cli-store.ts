/**
 * Reader for the Vercel CLI's own credential store — written by `sandbox login`
 * / `vercel login` (the `sandbox`/`sbx` CLI and `vercel` CLI share one store).
 *
 * AgentBox's "CLI-login" auth mode (see credentials.ts) drives that CLI for the
 * browser OAuth, then reads the resulting OAuth access token live from here on
 * every SDK call rather than copying it into `secrets.env`: the token is a
 * short-lived, opaque `vca_…` access token that the CLI refreshes lazily from
 * its stored refresh token, so the CLI store is the single self-refreshing
 * source of truth. We only cache the stable bits (team/project id + a marker)
 * in `secrets.env`.
 *
 * Pure FS + path logic — no clack, no execa — so it stays trivially testable.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The shape of the CLI's `auth.json` (only the fields we consume). */
export interface VercelCliAuth {
  /** Opaque OAuth access token (`vca_…`). NOT a JWT — expiry is `expiresAt`. */
  token: string;
  /** Unix seconds. Absent on some CLI versions → treated as near-expiry. */
  expiresAt?: number;
  /** Present but unused by us; the CLI uses it to self-refresh `token`. */
  refreshToken?: string;
}

/**
 * Resolve the `com.vercel.cli` data directory the way the CLI itself does
 * (xdg-app-paths-style), per platform:
 *   - macOS:   ~/Library/Application Support/com.vercel.cli
 *   - Windows: %APPDATA%\com.vercel.cli
 *   - else:    $XDG_DATA_HOME/com.vercel.cli  (default ~/.local/share/...)
 *
 * `AGENTBOX_VERCEL_CLI_DIR` overrides outright — for tests and the rare install
 * that relocates the store.
 */
export function vercelCliDir(): string {
  const override = process.env.AGENTBOX_VERCEL_CLI_DIR;
  if (override && override.trim().length > 0) return override.trim();

  const name = 'com.vercel.cli';
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', name);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData && appData.trim().length > 0) return join(appData, name);
    return join(homedir(), 'AppData', 'Roaming', name);
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg.trim() : join(homedir(), '.local', 'share');
  return join(base, name);
}

/** Absolute paths to the CLI store files, for status/diagnostics. */
export function cliStorePaths(): { authPath: string; configPath: string } {
  const dir = vercelCliDir();
  return { authPath: join(dir, 'auth.json'), configPath: join(dir, 'config.json') };
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the live access token from the CLI store. Returns null when the store is
 * missing / unparseable / has no token (CLI never logged in, or logged out) so
 * callers can surface a clear "run `agentbox vercel login`" error.
 */
export function readCliAuth(): VercelCliAuth | null {
  const raw = readJson(cliStorePaths().authPath) as Record<string, unknown> | null;
  if (!raw || typeof raw.token !== 'string' || raw.token.length === 0) return null;
  return {
    token: raw.token,
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : undefined,
    refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : undefined,
  };
}

/** Read the CLI's currently-selected team (`config.json` `currentTeam`). */
export function readCliCurrentTeam(): string | null {
  const raw = readJson(cliStorePaths().configPath) as Record<string, unknown> | null;
  return raw && typeof raw.currentTeam === 'string' && raw.currentTeam.length > 0
    ? raw.currentTeam
    : null;
}

/**
 * Whether the access token is at/near expiry and should be refreshed before
 * use. A missing `expiresAt` is treated as near-expiry so we always probe a
 * refresh rather than ship a token of unknown age. `skewSec` is the safety
 * window: refresh if the token expires within that many seconds.
 */
export function isNearExpiry(auth: VercelCliAuth, skewSec = 120): boolean {
  if (auth.expiresAt === undefined) return true;
  return auth.expiresAt * 1000 < Date.now() + skewSec * 1000;
}
