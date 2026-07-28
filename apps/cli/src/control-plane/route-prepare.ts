import type { EffectiveConfig } from '@agentbox/config';

/**
 * Whether a provider's base CAN be baked on the control box.
 *
 * Deliberately not {@link isHubRoutableProvider}, which answers a different
 * question (can a *box* be created there). The two differ on **remote-docker**:
 * its creates can't route to the hub — they run over your own `~/.ssh/config`,
 * which the control box has no access to — but its base is an image on a
 * **third** machine that both sides reach, and "is this host baked?" is answered
 * by asking that engine, not by trusting a local file. So a bake done from the
 * control box is immediately visible here, with no record to sync.
 *
 * Only plain `docker` is excluded: its base is an image on THIS machine, so
 * baking it elsewhere would produce an image on the wrong host.
 */
export function isHubBakeableProvider(provider: string): boolean {
  return provider !== 'docker';
}

export interface PrepareRoutingInput {
  /** Bare provider name (e.g. `e2b`, `docker`), post `parseProviderSpec`. */
  providerName: string;
  effective: EffectiveConfig;
  /**
   * remote-docker only: whether the control box has this host alias registered
   * (and so can SSH to it as itself). Resolved by the caller from
   * `GET /api/v1/hosts` and passed in to keep this pure. Undefined for every
   * other provider.
   */
  hubKnowsHost?: boolean;
  /** `--via-hub`: force the hub (the caller then hard-fails on missing prereqs). */
  forceHub?: boolean;
  /** `--local`: force a local bake even when a control box is configured. */
  forceLocal?: boolean;
  /**
   * Bake knobs the hub's prepare API does not accept (`--name`, `--location`,
   * `--size`). Passing one is an explicit request the hub can't honour, so it
   * keeps the bake here rather than silently dropping the flag.
   */
  localOnlyFlags?: string[];
  /**
   * Whether a control-box API target could be resolved (URL + `AGENTBOX_HUB_API_KEY`).
   * Passed in rather than resolved here so this stays pure and unit-testable.
   */
  hubApiAvailable: boolean;
}

export type PrepareRouting =
  | { where: 'hub' }
  // `fellBackReason` is set only when the hub WAS the default but a prerequisite
  // was missing — the caller surfaces it so the local bake isn't silent.
  | { where: 'local'; fellBackReason?: string };

/**
 * Decide whether a base bake runs on the control box or on this machine.
 *
 * The default is the control box, for the same reason creates route there: with
 * `cloud.viaHub` on, a cloud box is BUILT there from ITS prepared state, so a
 * bake done here is minutes spent on a base that will never be booted. The
 * record still comes back — the caller adopts it from custody afterwards — so
 * both sides end up current from one bake. (**remote-docker** is the exception
 * to the record half: its image lands on the shared remote host and freshness is
 * read off that engine, so there is nothing to adopt.)
 *
 * Stays local for:
 *   - `docker`, whose base is an image on THIS machine
 *     ({@link isHubBakeableProvider});
 *   - `remote-docker` when the control box doesn't know the host alias;
 *   - `--local`, or `cloud.viaHub=false`;
 *   - a flag the hub's prepare API can't carry;
 *   - no control box, or no API key for it.
 *
 * `--via-hub` returns `hub` for any provider that COULD bake there, so the
 * caller can hard-fail on a missing prerequisite instead of quietly baking here,
 * matching `--via-hub` on create. It cannot override the provider check above.
 */
export function resolvePrepareRouting(input: PrepareRoutingInput): PrepareRouting {
  const { providerName, effective, forceHub, forceLocal, hubApiAvailable } = input;
  if (forceLocal) return { where: 'local' };
  // BEFORE `--via-hub`, not after: a docker base is an image on THIS machine, so
  // "bake it on the control box" is not a thing the user can ask for — it would
  // bake that box's own image and leave this one untouched. The create path gets
  // away with checking after the flag only because `runCreateViaHub` rejects
  // docker downstream; there is no such second gate here, so the flag must not
  // be able to reach the hub with a local-only provider.
  if (!isHubBakeableProvider(providerName)) {
    return forceHub
      ? {
          where: 'local',
          fellBackReason: `a ${providerName} base is an image on this machine, so there is nothing to bake on the control box`,
        }
      : { where: 'local' };
  }
  // The control box bakes a remote-docker host by SSHing to it as ITSELF, so it
  // needs that alias in its own registry. Without it there is no host to reach,
  // and `--via-hub` can't conjure one.
  if (providerName === 'remote-docker' && input.hubKnowsHost === false) {
    return {
      where: 'local',
      fellBackReason: 'the control box has no such remote-docker host registered',
    };
  }
  if (forceHub) return { where: 'hub' };
  if (!effective.relay.controlPlaneUrl) return { where: 'local' };
  if (!effective.cloud.viaHub) return { where: 'local' };
  const localOnly = input.localOnlyFlags ?? [];
  if (localOnly.length > 0) {
    return {
      where: 'local',
      fellBackReason: `the control box's bake API does not accept ${localOnly.join(', ')}`,
    };
  }
  if (!hubApiAvailable) {
    return {
      where: 'local',
      fellBackReason: 'no control-box API key (run `agentbox hub setup`)',
    };
  }
  return { where: 'hub' };
}
