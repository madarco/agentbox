/**
 * The one box listing every host-side surface should read.
 *
 * `agentbox ls` has merged the control box's registry into the local boxes since
 * the thin-client work; the dashboard did not, so a hub-created box that `ls`
 * shows plainly was missing from the TUI. Both now go through here, so "what
 * boxes exist" has a single answer.
 *
 * Bounded and degrade-first by construction: `fetchHubListing` caps the
 * round-trip and falls back to an on-disk cache, and a null listing means "no
 * control box configured", in which case this is exactly `listBoxes()`.
 */
import { listBoxes } from '@agentbox/sandbox-docker';
import { fetchHubListing, type HubListing } from './hub-list.js';
import { mergeHubBoxes, type MergedBox } from './hub-merge.js';

export interface MergedListing {
  boxes: MergedBox[];
  /** The raw hub listing, for callers that report staleness. Null when no control box. */
  hub: HubListing | null;
}

/**
 * Local boxes merged with the control box's registry. Never throws on the hub
 * half — an unreachable control box yields the local boxes plus a stale marker
 * the caller can surface.
 */
export async function listBoxesMerged(): Promise<MergedListing> {
  const local = await listBoxes();
  const hub = await fetchHubListing().catch(() => null);
  return {
    boxes: mergeHubBoxes(local, hub ? hub.registrations : null, { stale: hub?.stale }),
    hub,
  };
}
