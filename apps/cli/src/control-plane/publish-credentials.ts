/**
 * The CLI-side credential publisher installed into `@agentbox/sandbox-core`'s
 * one-slot hook (see `setCredentialPublisher`). Each provider's interactive login
 * calls it after writing the local `secrets.env`; this mirrors the credential to
 * the hub's `POST /api/v1/providers/:id/credentials`, which validates it against
 * the cloud and persists it on the hub's machine.
 *
 * Why the local write ALSO stays (intentional + temporary): the IO plane is still
 * direct, so the PC needs provider credentials for `cp`/`attach` against the SDK
 * providers (e2b/vercel/daytona). The dual write goes away only when the IO plane
 * moves behind the hub — see `docs/hub-api-single-path-plan.md` → "Explicitly out
 * of scope". Do not remove the local write to "clean this up".
 *
 * Best-effort and non-spawning: a login must not start a hub daemon as a side
 * effect. We push to a hub that is ALREADY reachable — a running local hub, or a
 * configured control box — and otherwise leave the local write as the whole story
 * (with a nudge when a control box IS configured, since that is where the push
 * matters). Never throws: the caller's local write is the guaranteed outcome.
 */
import { log } from '@clack/prompts';
import { deadlineFetch, hostReachable } from '@agentbox/sandbox-cloud';
import { HubApiClient, HubApiError } from './hub-api-client.js';

/**
 * Bound on the whole publish. The hub validates against the cloud synchronously
 * (a real API round-trip for hetzner/daytona/vercel/DO), so this is generous —
 * but a login must never hang on an unreachable or slow hub.
 */
const PUBLISH_TIMEOUT_MS = 20_000;

export async function publishProviderCredentials(
  providerId: string,
  fields: Record<string, string>,
): Promise<void> {
  // Lazy import breaks the hub.ts <-> control-plane.ts module cycle (the same
  // reason `withHubClient` imports this resolver lazily).
  const { resolveHubApiTarget } = await import('../commands/control-plane.js');
  // Quiet: resolve without printing, and — crucially — without auto-starting a
  // local hub. A stopped local hub simply means "no push"; the local write stands.
  const target = await resolveHubApiTarget(undefined, { quiet: true }).catch(() => null);
  if (!target) {
    await warnIfControlBoxConfigured(providerId);
    return;
  }
  // Probe with a socket we own before the POST: a fetch to an unreachable host
  // can't be cancelled, and this runs inline in the login flow. Covers the
  // persisted-token-but-stopped-local-hub trap (the token outlives `hub stop`).
  if (!(await hostReachable(target.url, PUBLISH_TIMEOUT_MS))) {
    await warnIfControlBoxConfigured(providerId, target.url);
    return;
  }
  const client = new HubApiClient({
    ...target,
    fetchImpl: deadlineFetch(AbortSignal.timeout(PUBLISH_TIMEOUT_MS)),
  });
  try {
    await client.setProviderCredentials(providerId, fields);
    log.success(`Validated and pushed ${providerId} credentials to the hub (${target.url}).`);
  } catch (err) {
    const detail =
      err instanceof HubApiError ? err.message : err instanceof Error ? err.message : String(err);
    log.warn(
      `Saved locally, but the hub could not store the ${providerId} credentials: ${detail}\n` +
        'The local copy is enough for this machine; re-run the login once the hub is reachable.',
    );
  }
}

/**
 * When a control box IS configured but we couldn't push, say so: the push isn't
 * cosmetic there (the control box needs the credential to create cloud boxes). A
 * pure-local user with no control box gets no noise — their local write is all
 * there is to do.
 */
async function warnIfControlBoxConfigured(providerId: string, url?: string): Promise<void> {
  const { loadEffectiveConfig } = await import('@agentbox/config');
  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  if (!cfg?.effective.relay.controlPlaneUrl) return;
  log.warn(
    `Saved ${providerId} credentials locally, but could not reach the control box${url ? ` (${url})` : ''} to store them there.\n` +
      'Cloud boxes are built on the control box, so run this login again when it is reachable (or `agentbox hub secrets push`).',
  );
}
