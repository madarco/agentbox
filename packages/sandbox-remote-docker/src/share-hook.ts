/**
 * A one-slot hook the CLI uses to offer sharing a just-registered host with the
 * configured control box.
 *
 * Same shape and reason as `@agentbox/sandbox-core`'s credential publisher: the
 * registration flows (`remote-docker add`, the install wizard's
 * `interactiveRegisterHost`) live in this package, which must not depend on the
 * CLI's hub client or target resolution. So the CLI installs a handler at
 * startup and registration calls {@link offerHostShare} once the local registry
 * write has already succeeded.
 */

/** Offers to share `alias` with the control box. Owns its own user messaging. */
export type RemoteHostShareOffer = (alias: string) => Promise<void>;

let activeOffer: RemoteHostShareOffer | undefined;

/** Install (or clear, with `undefined`) the handler. The CLI calls this once. */
export function setRemoteHostShareOffer(fn: RemoteHostShareOffer | undefined): void {
  activeOffer = fn;
}

/**
 * Fire the handler, if one is installed. Best-effort: the host IS registered
 * locally by the time this runs, and a control box that is unreachable — or
 * absent entirely — must never turn a successful `add` into a failure.
 */
export async function offerHostShare(alias: string): Promise<void> {
  const fn = activeOffer;
  if (!fn) return;
  try {
    await fn(alias);
  } catch {
    /* best-effort — the handler owns any message worth showing */
  }
}
