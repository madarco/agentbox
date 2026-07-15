/**
 * `--provider` accepts a *spec*, not just a name: `docker:<host>` means "the
 * docker engine on <host>", i.e. the remote-docker provider pointed at that SSH
 * destination.
 *
 *     agentbox docker:buildbox claude
 *     agentbox create --provider docker:dev@10.0.0.9:2222
 *     agentbox prepare --provider docker:buildbox
 *
 * Reading `docker:` as the base is deliberate: to the user this IS docker, just
 * not here. `remote-docker:<host>` is accepted too, for anyone who reaches for
 * the provider's real name.
 *
 * Everything that takes a `--provider` runs its value through `parseProviderSpec`,
 * so a spec works anywhere a bare name does. A name with no `:` parses to
 * itself, which keeps every existing call site's behavior exactly as it was.
 */

export const REMOTE_DOCKER = 'remote-docker';

export interface ProviderSpec {
  /** The provider name to resolve (`remote-docker` for a `docker:<host>` spec). */
  name: string;
  /** The SSH destination, when the spec named one. */
  remoteHost?: string;
}

/**
 * Split `<base>:<host>` on the FIRST colon — everything after it is the SSH
 * destination, which may itself contain a `:port` suffix
 * (`docker:dev@10.0.0.9:2222` → host `dev@10.0.0.9:2222`).
 */
export function parseProviderSpec(spec: string): ProviderSpec {
  const raw = spec.trim();
  const colon = raw.indexOf(':');
  if (colon < 0) return { name: raw };

  const base = raw.slice(0, colon);
  const host = raw.slice(colon + 1).trim();
  if (base !== 'docker' && base !== REMOTE_DOCKER) {
    // Not a remote spec — hand the whole string back and let the caller's
    // unknown-provider error name it, rather than silently reinterpreting it.
    return { name: raw };
  }
  if (host.length === 0) {
    throw new Error(
      `provider "${raw}" names no host — write \`${base}:<ssh-host>\` (an ~/.ssh/config alias or [user@]host[:port])`,
    );
  }
  return { name: REMOTE_DOCKER, remoteHost: host };
}

/** The provider name a spec resolves to, ignoring any host. */
export function providerNameOf(spec: string): string {
  return parseProviderSpec(spec).name;
}
