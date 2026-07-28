import type { EffectiveConfig } from '@agentbox/config';
import { isHubRoutableProvider } from '@agentbox/config';

export interface PrepareRoutingInput {
  /** Bare provider name (e.g. `e2b`, `docker`), post `parseProviderSpec`. */
  providerName: string;
  effective: EffectiveConfig;
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
 * both sides end up current from one bake.
 *
 * Stays local for:
 *   - `docker` / `remote-docker`, whose bases are local images, not portable
 *     snapshots ({@link isHubRoutableProvider} is exactly that distinction);
 *   - `--local`, or `cloud.viaHub=false`;
 *   - a flag the hub's prepare API can't carry;
 *   - no control box, or no API key for it.
 *
 * `--via-hub` returns `hub` unconditionally so the caller can hard-fail on the
 * missing prerequisite instead of quietly baking here, matching `--via-hub` on
 * create.
 */
export function resolvePrepareRouting(input: PrepareRoutingInput): PrepareRouting {
  const { providerName, effective, forceHub, forceLocal, hubApiAvailable } = input;
  if (forceLocal) return { where: 'local' };
  if (forceHub) return { where: 'hub' };
  if (!isHubRoutableProvider(providerName)) return { where: 'local' };
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
