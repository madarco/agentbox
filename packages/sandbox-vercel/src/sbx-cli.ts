/**
 * Driver for the official Vercel Sandbox CLI (`sandbox` / `sbx`, installed via
 * `npm i -g sandbox`). AgentBox's CLI-login auth mode uses it for two things:
 *   - `loginSbx`     — run `sandbox login` interactively so the user completes
 *     the browser OAuth and the CLI writes its own credential store.
 *   - `refreshSbxToken` — run a cheap read command (`sandbox list`) which makes
 *     the CLI lazily refresh its access token from its stored refresh token
 *     when the token is stale. Verified non-interactive: a stale token is
 *     refreshed without opening a browser.
 *
 * Mirrors the probe/install patterns in sandbox-docker/src/portless.ts: execa
 * with `reject:false` for never-throw probes, spawnSync with inherited stdio for
 * the interactive login.
 */

import { spawnSync } from 'node:child_process';
import { execa } from 'execa';

/**
 * Binaries the Sandbox CLI installs. `sbx` is the short alias; we prefer it but
 * fall back to `sandbox`. Pinned here so a future rename is a one-line fix.
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
 * change mid-command); `resetSbxCache` clears it after an install or for tests.
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

/** Command the user should run to install the Sandbox CLI. */
export function installSbxHint(): string {
  return 'npm install -g sandbox';
}

/** Install the Sandbox CLI globally (`npm install -g sandbox`). Never throws. */
export async function installSbx(): Promise<boolean> {
  try {
    const r = await execa('npm', ['install', '-g', 'sandbox'], { reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Run `sandbox login` with inherited stdio so the user sees the CLI's own
 * browser-OAuth output and can interact with it. Blocking, like the interactive
 * agent launch path. Returns the exit status (0 = success).
 */
export function loginSbx(bin: string): number {
  const r = spawnSync(bin, ['login'], { stdio: 'inherit' });
  return r.status ?? 1;
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
