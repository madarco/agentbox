/**
 * Driver for the official Vercel Sandbox CLI (`sandbox` / `sbx`, installed via
 * `npm i -g sandbox`). This example reuses the CLI for two things:
 *   - `refreshSbxToken` — run a cheap read command (`sandbox list`) which makes
 *     the CLI lazily refresh its access token from its stored refresh token when
 *     the token is stale (non-interactive; no browser).
 *   - `detectSbx`      — probe whether the CLI is present, for interactive attach
 *     (`agentbox shell|claude|...` drives `sbx exec` for a real PTY).
 *
 * Trimmed from the built-in provider's version: the interactive install/login
 * helpers live only in the built-in `agentbox vercel login` — this example
 * reuses that login (shared `~/.agentbox/secrets.env` + Vercel CLI store).
 */

import { execa } from 'execa';

/**
 * Binaries the Sandbox CLI installs. `sbx` is the short alias; we prefer it but
 * fall back to `sandbox`.
 */
const SBX_BINS = ['sbx', 'sandbox'] as const;

export interface SbxState {
  /** A Sandbox CLI binary resolved on PATH and answered `--version`. */
  installed: boolean;
  /** The binary name that answered (`sbx` or `sandbox`), when installed. */
  bin?: string;
  /** Version string, when installed. */
  version?: string;
}

let cached: SbxState | null = null;

/**
 * Probe the host for the Sandbox CLI. Cached per-process (install state can't
 * change mid-command); `resetSbxCache` clears it for tests.
 */
export async function detectSbx(): Promise<SbxState> {
  if (cached !== null) return cached;
  for (const bin of SBX_BINS) {
    try {
      const r = await execa(bin, ['--version'], { reject: false });
      if (r.exitCode === 0) {
        cached = { installed: true, bin, version: (r.stdout ?? '').trim() || undefined };
        return cached;
      }
    } catch {
      // try the next bin name
    }
  }
  cached = { installed: false };
  return cached;
}

/** Drop the per-process probe cache so the next `detectSbx()` re-probes. */
export function resetSbxCache(): void {
  cached = null;
}

/**
 * Trigger the CLI's lazy token refresh by running a cheap read command. The CLI
 * refreshes its access token from the stored refresh token when the token is
 * stale and leaves a still-valid token untouched, so this is safe to call
 * eagerly. Non-interactive (stdin from /dev/null); returns true on exit 0.
 */
export async function refreshSbxToken(bin: string): Promise<boolean> {
  try {
    const r = await execa(bin, ['list'], {
      reject: false,
      timeout: 30_000,
      stdin: 'ignore',
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}
