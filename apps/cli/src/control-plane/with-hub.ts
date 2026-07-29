/**
 * `withHubClient` — the one entry point CLI commands use to run an operation
 * against the hub's `/api/v1`, in BOTH modes (a local hub or a remote control
 * box; the only difference is the base URL + token, resolved by
 * `resolveHubApiTarget`). It:
 *
 *   1. resolves the client (auto-starting a local hub when needed),
 *   2. gates the hub's `/api/v1` version once up front — a hub outside
 *      {@link SUPPORTED_HUB_API_VERSIONS} is refused with an upgrade hint rather
 *      than failing on a changed field mid-operation,
 *   3. runs the caller's op, and
 *   4. maps a {@link HubApiError} (or an unreachable hub) to a stable CLI exit
 *      code + an actionable message.
 *
 * Later steps of the `/api/v1` consolidation are then a mechanical conversion:
 * wrap the op body in `withHubClient` and delete the inline provider code. A
 * command that needs to special-case a code (e.g. treat `not_found` as info)
 * catches it inside its own callback before it reaches the mapper here.
 */
import { log } from '@clack/prompts';
import type { HubTarget } from '../commands/hub.js';
import { HubApiClient, HubApiError, SUPPORTED_HUB_API_VERSIONS } from './hub-api-client.js';

export interface WithHubOptions {
  /** Override the hub URL (default: the configured control box, else the local hub). */
  url?: string;
}

/** True when the hub's reported `apiVersion` is one this CLI speaks. */
export function isSupportedApiVersion(version: string | undefined): boolean {
  return (
    version !== undefined && (SUPPORTED_HUB_API_VERSIONS as readonly string[]).includes(version)
  );
}

// Distinct exit codes per API error class, so scripts can branch on the failure
// kind. `not_found` reuses 2 to match the lifecycle-error convention
// (`handleLifecycleError`). Anything unmapped (including `internal`) is a plain 1.
const EXIT_BY_CODE: Record<string, number> = {
  not_found: 2,
  unauthorized: 3,
  invalid_request: 4,
  conflict: 5,
  backend_unavailable: 6,
};

/** The CLI exit code for a hub `/api/v1` error code. */
export function exitCodeForApiError(code: string): number {
  return EXIT_BY_CODE[code] ?? 1;
}

/** An extra actionable line for the error classes where the raw message isn't enough. */
function hintForApiError(err: HubApiError): string | null {
  switch (err.code) {
    case 'unauthorized':
      return 'The hub rejected the API token. Restart a local hub with `agentbox hub restart`, or check AGENTBOX_HUB_API_KEY for a remote control box.';
    case 'backend_unavailable':
      return "The hub reached its backend but it was unavailable — the provider or host it needs may not be configured on the hub's machine.";
    default:
      return null;
  }
}

/**
 * Map a resolved {@link HubTarget} to the `/api/v1` client target, or the reason
 * it can't be used. Pure — the local⇄remote logic lives in `resolveHubTarget`;
 * this only converts `token`→`apiKey` and decides whether a token is present.
 * The token IS the Bearer for both modes (a local hub's token, or a control
 * box's `AGENTBOX_HUB_API_KEY`).
 */
export function hubApiTargetFrom(
  target: HubTarget,
):
  | { ok: true; url: string; apiKey: string }
  | { ok: false; reason: 'no-token'; mode: 'local' | 'remote' } {
  if (!target.token) return { ok: false, reason: 'no-token', mode: target.mode };
  return { ok: true, url: target.url, apiKey: target.token };
}

/** Print a hub failure and set the matching exit code. Never throws. */
function reportHubError(err: unknown, url: string): void {
  if (err instanceof HubApiError) {
    log.error(err.message);
    const hint = hintForApiError(err);
    if (hint) log.info(hint);
    process.exitCode = exitCodeForApiError(err.code);
    return;
  }
  // A fetch/network failure (hub down, wrong URL) surfaces as a plain Error.
  log.error(`Can't reach the hub at ${url}: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

export async function withHubClient<T>(
  opts: WithHubOptions,
  fn: (client: HubApiClient) => Promise<T>,
): Promise<T | undefined> {
  // Lazy import breaks the hub.ts <-> control-plane.ts module cycle that both of
  // those already sit in (hub.ts consumes control-plane.ts's command list at
  // load time). Cheap after the first call — the module is cached.
  const { resolveHubApiTarget } = await import('../commands/control-plane.js');
  const target = await resolveHubApiTarget(opts.url);
  if (!target) {
    // resolveHubApiTarget already printed an actionable error (missing config /
    // key, or a local-hub autostart failure).
    process.exitCode = 1;
    return undefined;
  }
  const client = new HubApiClient(target);

  // Version gate — also the first authed-adjacent round-trip, so an unreachable
  // hub is reported here rather than surfacing later as a confusing op failure.
  try {
    const health = await client.health();
    if (!isSupportedApiVersion(health.apiVersion)) {
      log.error(
        `The hub at ${target.url} serves API ${health.apiVersion ? `"${health.apiVersion}"` : '(none reported)'}, ` +
          `which this CLI doesn't support (needs ${SUPPORTED_HUB_API_VERSIONS.join(', ')}).`,
      );
      log.info(
        'Upgrade it (`agentbox hub update` for a remote control box, or `agentbox hub restart` for a local hub) or update this CLI to match.',
      );
      process.exitCode = 1;
      return undefined;
    }
  } catch (err) {
    if (err instanceof HubApiError) {
      // A hub too old to expose /api/v1 answers the probe with an error envelope.
      log.error(
        `The hub at ${target.url} didn't answer the /api/v1 health probe (${err.code}). It may be too old — upgrade it.`,
      );
      process.exitCode = 1;
    } else {
      reportHubError(err, target.url);
    }
    return undefined;
  }

  try {
    return await fn(client);
  } catch (err) {
    reportHubError(err, target.url);
    return undefined;
  }
}
