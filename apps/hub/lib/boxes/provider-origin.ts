/**
 * Which machine each provider row describes.
 *
 * With a control box configured, a cloud create routes there and is built from
 * ITS baked bases (`cloud.viaHub`) — this host's cloud bakes are never used. The
 * hub UI nonetheless reported its own, so `agentbox.localhost` could insist
 * "hetzner — needs bake" while `agentbox hetzner` created boxes fine.
 *
 * Pure so the one rule that matters is testable without a hub or a network: an
 * unreachable control box must never fall back to this host's row under a
 * control-box label. That would not be a degraded answer, it would be a wrong
 * one — a claim about the readiness of a machine we did not reach.
 */
import { isHubRoutableProvider } from '@agentbox/config';
import type { ProviderOption } from './types';

export interface MergeRemoteProvidersInput {
  /** This host's rows, as `listProviders` computed them. */
  local: ProviderOption[];
  /**
   * The control box's rows; `null` when it is configured but unreachable, and
   * `undefined` when there is no control box at all (everything stays local).
   */
  remote: ProviderOption[] | null | undefined;
  /** The control box's URL, for the out-links on a `hub` row. */
  hubUrl?: string;
}

/**
 * Replace every hub-routable (true cloud) row with the control box's.
 *
 * Docker and remote-docker stay local: their bases are local images on a
 * specific machine, not portable snapshots, so no other host can answer for
 * them.
 */
export function mergeRemoteProviders(input: MergeRemoteProvidersInput): ProviderOption[] {
  const { local, remote, hubUrl } = input;
  if (remote === undefined) return local;
  const byId = new Map((remote ?? []).map((p) => [p.id, p]));
  return local.map((p) => {
    if (!isHubRoutableProvider(p.id)) return { ...p, origin: 'local' as const };
    const hub = byId.get(p.id);
    if (!hub) {
      const unreachable = remote === null;
      return {
        ...p,
        origin: 'hub' as const,
        hubUrl,
        configured: false,
        // Undefined, NOT false, when we couldn't reach the box: "no credentials"
        // is a specific claim, and the honest answer is that we don't know. The
        // badge renders undefined as "unknown".
        hasCredentials: unreachable ? undefined : false,
        jobId: undefined,
        baseStatus: undefined,
        baseStaleReason: undefined,
        bakeDiff: undefined,
        reason: unreachable
          ? 'Control box unreachable — its setup state is unknown.'
          : 'Not set up on the control box.',
      };
    }
    // Keep OUR label (the local catalog is the display source) and take
    // everything about readiness from the box that will do the work.
    return { ...hub, label: p.label, origin: 'hub' as const, hubUrl };
  });
}
