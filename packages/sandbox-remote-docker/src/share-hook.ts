/**
 * Two one-slot hooks the CLI fills for a just-registered host: share it with the
 * configured control box, and bake its box image wherever that bake belongs.
 *
 * Same shape and reason as `@agentbox/sandbox-core`'s credential publisher: the
 * registration flows (`remote-docker add`, the install wizard's
 * `interactiveRegisterHost`) live in this package, which must not depend on the
 * CLI's hub client or target resolution. So the CLI installs the handlers at
 * startup and registration calls {@link shareRegisteredHost} / {@link
 * bakeRegisteredHost} once the local registry write has already succeeded.
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

/**
 * Bakes `alias`'s box image, wherever that bake belongs — the control box when
 * it has been given the host, this machine's hub otherwise. Owns its own user
 * messaging (including its spinner); throws on failure.
 */
export type RemoteHostBaker = (alias: string) => Promise<void>;

let activeBaker: RemoteHostBaker | undefined;

/** Install (or clear, with `undefined`) the handler. The CLI calls this once. */
export function setRemoteHostBaker(fn: RemoteHostBaker | undefined): void {
  activeBaker = fn;
}

/**
 * Fire the bake handler, if one is installed; `false` means there was none and
 * the caller should bake inline itself.
 *
 * Unlike {@link shareRegisteredHost} this does NOT swallow errors: the caller
 * decides what a failed bake means (for `remote-docker add` it is a warning, not
 * a failed registration) and needs the reason to say it.
 */
export async function bakeRegisteredHost(alias: string): Promise<boolean> {
  const fn = activeBaker;
  if (!fn) return false;
  await fn(alias);
  return true;
}
