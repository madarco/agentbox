/**
 * A one-slot hook the CLI uses to mirror a freshly-set provider credential to the
 * hub's `POST /api/v1/providers/:id/credentials` (which validates it against the
 * cloud and persists it on the hub's machine).
 *
 * Why a hook and not a direct call: the interactive login flows live in the
 * `@agentbox/sandbox-<provider>` packages, which must not depend on the CLI (the
 * hub client, target resolution). So the CLI installs a publisher at startup and
 * each provider's `ensureXCredentials` calls {@link publishManagedCredentials}
 * after it has written the local `secrets.env`.
 *
 * TEMPORARY — the two writes (local `secrets.env` + the hub POST) are deliberate
 * while the IO plane stays direct: the PC still needs provider credentials for
 * `cp`/`attach` against the SDK providers (e2b/vercel/daytona), so a login writes
 * locally AND pushes to the hub. Do not "clean up" the local write; it goes away
 * only when the IO plane moves behind the hub (see
 * `docs/hub-api-single-path-plan.md` → "Explicitly out of scope").
 *
 * Only the INTERACTIVE credential setter publishes — never the headless
 * `setCredentials` the hub itself drives, or a POST would loop back into the hub.
 */

/** Publishes a provider's canonical credential fields to the configured hub. */
export type CredentialPublisher = (
  providerId: string,
  fields: Record<string, string>,
) => Promise<void>;

let activePublisher: CredentialPublisher | undefined;

/**
 * Install (or clear, with `undefined`) the publisher. The CLI calls this once at
 * startup; a provider package used on its own — or any process that never
 * installs one — publishes nothing.
 */
export function setCredentialPublisher(fn: CredentialPublisher | undefined): void {
  activePublisher = fn;
}

/**
 * Push a just-set credential to the hub, if a publisher is installed. Best-effort:
 * a failed push must never break a local login (the local `secrets.env` write is
 * the guaranteed outcome), so this never throws — the publisher owns any
 * user-facing success/warn message.
 */
export async function publishManagedCredentials(
  providerId: string,
  fields: Record<string, string>,
): Promise<void> {
  const fn = activePublisher;
  if (!fn) return;
  try {
    await fn(providerId, fields);
  } catch {
    /* best-effort — the publisher already reports failures it wants surfaced */
  }
}
