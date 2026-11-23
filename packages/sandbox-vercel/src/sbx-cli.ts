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
import { accessSync, closeSync, constants, openSync, readSync } from 'node:fs';
import { delimiter, join } from 'node:path';
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
  /** Absolute path of the resolved binary on PATH, when found. */
  path?: string;
  /** Major of the Node the CLI runs under (its shebang / PATH `node`), when known. */
  nodeMajor?: number;
  /**
   * The installed CLI is older than `MIN_SBX_MAJOR`. On its own that is only a
   * warning: the old build works on Node < `BROKEN_NODE_MAJOR`.
   */
  outdated?: boolean;
  /**
   * Outdated AND running under Node >= `BROKEN_NODE_MAJOR`: every large API
   * response fails, so interactive attach must refuse it.
   */
  broken?: boolean;
}

/**
 * Oldest Sandbox CLI major we drive. sbx 3.x bundles undici 7.26; under Node 26
 * its dispatcher makes the built-in fetch skip content decoding, so every large
 * (compressed) response fails with "Sandbox API request failed … 200 OK".
 */
export const MIN_SBX_MAJOR = 4;

/** First Node major whose built-in fetch breaks an outdated sbx (see above). */
export const BROKEN_NODE_MAJOR = 26;

/**
 * An outdated sbx is broken only under Node >= `BROKEN_NODE_MAJOR`. An unknown
 * Node is not called broken: refusing a CLI that may work is worse than the
 * opaque error it may print.
 */
export function isSbxBroken(outdated: boolean, nodeMajor: number | undefined): boolean {
  return outdated && nodeMajor !== undefined && nodeMajor >= BROKEN_NODE_MAJOR;
}

/** Resolve `bin` on PATH to an absolute path (first executable match). */
export function resolveOnPath(bin: string, pathEnv = process.env.PATH ?? ''): string | undefined {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * The Node a CLI script runs under: an absolute `#!/…/node` shebang names it,
 * anything else (`#!/usr/bin/env node`, a pnpm/npm shell shim) runs PATH `node`.
 */
export function shebangNode(head: string): string | undefined {
  const first = head.split('\n', 1)[0] ?? '';
  const m = /^#!\s*(\/\S*\/node)\s*$/.exec(first);
  return m ? m[1] : undefined;
}

export function parseNodeMajor(v: string | undefined): number | undefined {
  const m = /^v?(\d+)\./.exec((v ?? '').trim());
  return m ? Number(m[1]) : undefined;
}

async function probeNodeMajor(binPath: string | undefined): Promise<number | undefined> {
  let node = 'node';
  if (binPath) {
    try {
      const fd = openSync(binPath, 'r');
      try {
        const buf = Buffer.alloc(256);
        const n = readSync(fd, buf, 0, buf.length, 0);
        node = shebangNode(buf.subarray(0, n).toString('utf8')) ?? 'node';
      } finally {
        closeSync(fd);
      }
    } catch {
      // unreadable: fall back to PATH node
    }
  }
  try {
    const r = await execa(node, ['--version'], { reject: false });
    return r.exitCode === 0 ? parseNodeMajor(r.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** True when `binPath` lives in a pnpm global bin dir (`npm i -g` won't replace it). */
export function isPnpmGlobal(binPath: string | undefined): boolean {
  if (!binPath) return false;
  const pnpmHome = process.env.PNPM_HOME;
  if (pnpmHome && binPath.startsWith(pnpmHome.replace(/\/+$/, '') + '/')) return true;
  return /[/\\]\.?pnpm[/\\]/i.test(binPath);
}

/** Parse the major out of `sbx --version` output (`3.0.1`, `sandbox/4.13.0`, …). */
export function parseSbxMajor(version: string | undefined): number | null {
  const m = /(\d+)\.\d+(?:\.\d+)?/.exec(version ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * True when `version` is below `MIN_SBX_MAJOR`. An unparsable version is not
 * called outdated: a future output format must not lock users out of attach.
 */
export function isSbxOutdated(version: string | undefined): boolean {
  const major = parseSbxMajor(version);
  return major !== null && major < MIN_SBX_MAJOR;
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
        const version = (r.stdout ?? '').trim() || undefined;
        const path = resolveOnPath(bin);
        const outdated = isSbxOutdated(version);
        const nodeMajor = outdated ? await probeNodeMajor(path) : undefined;
        cached = {
          installed: true,
          bin,
          version,
          outdated,
          broken: isSbxBroken(outdated, nodeMajor),
          ...(path ? { path } : {}),
          ...(nodeMajor !== undefined ? { nodeMajor } : {}),
        };
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
 * Command the user should run to install or update the Sandbox CLI. A pnpm
 * global install shadows an npm one on PATH, so updating it needs pnpm.
 */
export function installSbxHint(det?: Pick<SbxState, 'path'>): string {
  return isPnpmGlobal(det?.path) ? 'pnpm add -g sandbox@latest' : 'npm install -g sandbox@latest';
}

/** `installSbxHint` plus the resolved binary, for update messages. */
export function updateSbxHint(det: Pick<SbxState, 'path'>): string {
  return det.path
    ? `\`${installSbxHint(det)}\` (the CLI on PATH is ${det.path})`
    : `\`${installSbxHint(det)}\``;
}

/**
 * Install or update the Sandbox CLI globally with the package manager that owns
 * the current install (`pnpm add -g` for a pnpm global, else `npm install -g`).
 * `@latest` so an update past an outdated install actually moves. Never throws.
 */
export async function installSbx(det?: Pick<SbxState, 'path'>): Promise<boolean> {
  const [cmd, ...args] = installSbxHint(det).split(' ');
  try {
    const r = await execa(cmd!, args, { reject: false });
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
