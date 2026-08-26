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

import type { EffectiveConfig } from '@agentbox/config';
import { parseProviderSpec, REMOTE_DOCKER } from '@agentbox/config';

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

/**
 * Resolve the provider + engine for a command, in one place.
 *
 * `box.provider` is stored as a bare provider NAME (the parser splits a
 * `docker:<host>` spec into `box.provider` + `box.remoteDockerHost`), so a
 * command can no longer get the host out of the config value itself. It has to
 * read the second key — and it must, because `dockerProviderRefusal` decides
 * whether a remote-docker create is allowed by whether the control box can
 * reach that host: a dropped host reads as "no engine" and refuses the create.
 *
 * Precedence, unchanged from when the spec carried the host: an explicit
 * `--remote-host` beats the host inside `--provider docker:<host>`, which beats
 * the configured `box.remoteDockerHost`.
 */
export function resolveProviderChoice(
  cfg: EffectiveConfig,
  opts: { provider?: string; remoteHost?: string } = {},
): { providerName: string; remoteHost: string | undefined; spec: string } {
  const { name: providerName, remoteHost: specHost } = parseProviderSpec(
    opts.provider?.trim() || cfg.box.provider || 'docker',
  );
  const host =
    opts.remoteHost?.trim() || specHost || (cfg.box.remoteDockerHost || '').trim() || undefined;
  // Only remote-docker has an engine; carrying a stray host onto a cloud
  // provider would make `--remote-host` look honoured when it is ignored.
  const remoteHost = providerName === REMOTE_DOCKER ? host : undefined;
  return { providerName, remoteHost, spec: providerSpecFor(providerName, remoteHost) };
}

/**
 * The wire form for the hub API, which still speaks the spec: the hub worker
 * splits it again on its side (`parseProviderSpec` in `hub-worker.ts`). Only
 * remote-docker re-sugars; every other name is already the whole story.
 */
export function providerSpecFor(providerName: string, remoteHost: string | undefined): string {
  return providerName === REMOTE_DOCKER && remoteHost ? `docker:${remoteHost}` : providerName;
}
