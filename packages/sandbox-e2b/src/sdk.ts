/**
 * Thin wrapper around the `e2b` SDK. Resolves the API key once and re-exports
 * the SDK surface the rest of the package uses from a single place (so tests
 * can mock `./sdk.js` instead of the package).
 *
 * E2B only ships one auth mode for first-party use: a single API key. The SDK
 * already reads `process.env.E2B_API_KEY` on each call, but we still expose
 * `resolveApiKey()` so callers can fail loud with an actionable error before
 * the SDK throws a generic "401 unauthorized" deep inside an op.
 */

import { Sandbox, Template } from 'e2b';
import { ensureE2bEnvLoaded } from './env-loader.js';

export { Sandbox, Template };
export type { SandboxOpts, SandboxInfo, SandboxState, SandboxListOpts, LogEntry, BuildInfo } from 'e2b';

/**
 * Return the configured E2B API key. Throws an actionable error when nothing
 * is configured. Idempotent — env-loader caches itself after first call.
 */
export function resolveApiKey(): string {
  ensureE2bEnvLoaded();
  const k = process.env.E2B_API_KEY;
  if (!k) {
    throw new Error(
      'E2B credentials not configured.\n' +
        'Run `agentbox e2b login` to paste your API key (from https://e2b.dev/dashboard?tab=keys), ' +
        'or set E2B_API_KEY in the environment / ~/.agentbox/secrets.env.',
    );
  }
  return k;
}

/** True when an API key is configured. Used by the credential gate. */
export function hasUsableCredentials(): boolean {
  ensureE2bEnvLoaded();
  return Boolean(process.env.E2B_API_KEY);
}
