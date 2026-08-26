/**
 * `--provider` accepts a *spec*, not just a name — see
 * `@agentbox/config`'s `provider-spec.ts`, which owns the parser so the CLI and
 * the hub cannot drift on what `docker:<host>` means.
 *
 * Everything that takes a `--provider` runs its value through `parseProviderSpec`,
 * so a spec works anywhere a bare name does. A name with no `:` parses to
 * itself, which keeps every existing call site's behavior exactly as it was.
 */

export {
  parseProviderSpec,
  providerNameOf,
  REMOTE_DOCKER,
  type ProviderSpec,
} from '@agentbox/config';

import { parseProviderSpec } from '@agentbox/config';

/**
 * The effective provider spec for a queued create job, folding a `remoteHost`
 * (the `--remote-host` flag) into the spec. A `--remote-host` on an otherwise-bare
 * `docker` job IS a remote-docker box — encode it as `docker:<host>` so the worker
 * resolves the REMOTE engine, not the local one (a bare `docker` job would build
 * on this machine, silently ignoring the host the submitter asked for). A cloud
 * name, or an explicit `docker:<host>` spec (which already carries its host), pass
 * through unchanged.
 */
export function resolveCreateProviderSpec(
  providerName: string | undefined,
  remoteHost: string | undefined,
): string {
  const raw = (providerName && providerName.trim()) || 'docker';
  if (remoteHost && parseProviderSpec(raw).name === 'docker') return `docker:${remoteHost}`;
  return raw;
}
