/**
 * Credential handling for the example provider — deliberately slim.
 *
 * The example is Vercel-backed and reuses the built-in Vercel provider's
 * credentials verbatim: the same `~/.agentbox/secrets.env` keys (written by
 * `agentbox vercel login`) and the same Vercel CLI store. So there is NO separate
 * login wizard here — `ensureExampleCredentials` just checks that usable creds
 * exist and, if not, points the user at `agentbox vercel login`.
 *
 * A real standalone provider plugin would implement its own `ensureCredentials`
 * (a browser/token flow persisting to `~/.agentbox/secrets.env`); this one leans
 * on the built-in to keep the example focused on the provider surface.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { log, note } from '@clack/prompts';
import { ensureVercelEnvLoaded } from './env-loader.js';
import { hasUsableCredentials } from './sdk.js';
import { cliStorePaths, isNearExpiry, readCliAuth } from './cli-store.js';

export interface EnsureExampleCredentialsOptions {
  /** Re-check even when creds are already present (parity with the CLI flag). */
  force?: boolean;
}

/**
 * No-op when Vercel credentials are already configured (the common case for this
 * internal example — you've already run `agentbox vercel login`). Otherwise, on
 * a TTY, tell the user to run the built-in login (which this example reuses).
 * Silent no-op when stdin isn't a TTY so scripted callers get the SDK's clear
 * "not configured" error instead of a hung prompt.
 */
export function ensureExampleCredentials(
  _opts: EnsureExampleCredentialsOptions = {},
): Promise<void> {
  ensureVercelEnvLoaded();
  if (hasUsableCredentials()) return Promise.resolve();
  if (!process.stdin.isTTY) return Promise.resolve();
  note(
    'The example provider reuses the built-in Vercel provider credentials.\n' +
      'Run `agentbox vercel login` once (any auth mode), then retry — it writes the\n' +
      'shared `~/.agentbox/secrets.env` keys this example reads.',
    'Credentials required',
  );
  log.warn('No usable Vercel credentials found for the example provider.');
  return Promise.resolve();
}

export interface ExampleCredStatus {
  /** Which auth mode is configured. */
  auth: 'oidc' | 'cli' | 'token' | 'none';
  source: 'env' | 'secrets.env' | 'cli-store' | 'none';
  /** CLI mode only: live-session details. */
  cli?: { loggedIn: boolean; nearExpiry?: boolean; authPath: string };
}

/** Report the configured auth mode, mirroring the built-in provider's status. */
export function readExampleCredStatus(): ExampleCredStatus {
  const shellHad = !!process.env.VERCEL_OIDC_TOKEN || !!process.env.VERCEL_TOKEN;
  ensureVercelEnvLoaded();

  if (process.env.VERCEL_OIDC_TOKEN) {
    return { auth: 'oidc', source: shellHad ? 'env' : 'secrets.env' };
  }
  if (process.env.VERCEL_AUTH_SOURCE === 'cli') {
    const auth = readCliAuth();
    return {
      auth: 'cli',
      source: 'cli-store',
      cli: {
        loggedIn: !!auth,
        nearExpiry: auth ? isNearExpiry(auth) : undefined,
        authPath: cliStorePaths().authPath,
      },
    };
  }
  if (process.env.VERCEL_TOKEN) {
    return { auth: 'token', source: shellHad ? 'env' : 'secrets.env' };
  }
  return { auth: 'none', source: 'none' };
}

export function secretsPath(): string {
  return resolve(homedir(), '.agentbox', 'secrets.env');
}

export function maskKey(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${'*'.repeat(8)}${value.slice(-4)}`;
}
