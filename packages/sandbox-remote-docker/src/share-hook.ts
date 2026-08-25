/**
 * A one-slot hook the CLI uses to share a just-registered host with the
 * configured control box.
 *
 * Same shape and reason as `@agentbox/sandbox-core`'s credential publisher: the
 * registration flows (`remote-docker add`, the install wizard's
 * `interactiveRegisterHost`) live in this package, which must not depend on the
 * CLI's hub client or target resolution. So the CLI installs a handler at
 * startup and registration calls {@link shareRegisteredHost} once the local
 * registry write has already succeeded.
 */

/** Shares `alias` with the control box. Owns its own user messaging. */
export type RemoteHostSharer = (alias: string) => Promise<void>;

let activeSharer: RemoteHostSharer | undefined;

/** Install (or clear, with `undefined`) the handler. The CLI calls this once. */
export function setRemoteHostSharer(fn: RemoteHostSharer | undefined): void {
  activeSharer = fn;
}

/**
 * Fire the handler, if one is installed. Best-effort: the host IS registered
 * locally by the time this runs, and a control box that is unreachable — or
 * absent entirely — must never turn a successful `add` into a failure.
 */
export async function shareRegisteredHost(alias: string): Promise<void> {
  const fn = activeSharer;
  if (!fn) return;
  try {
    await fn(alias);
  } catch {
    /* best-effort — the handler owns any message worth showing */
  }
}
