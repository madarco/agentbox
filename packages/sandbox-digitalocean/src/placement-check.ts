import { UserFacingError } from '@agentbox/core';
import type { PlacementCheck } from '@agentbox/sandbox-core';
import {
  DIGITALOCEAN_DEFAULT_SIZE,
  preparedImageIdFor,
  resolvedVariantForImage,
} from './backend.js';
import { readDigitalOceanCredStatus } from './credentials.js';
import {
  makeDigitalOceanClient,
  type DigitalOceanClient,
  type DigitalOceanSize,
  type DigitalOceanSnapshot,
} from './client.js';
import { validateSizeChoice } from './preflight.js';
import { readPreparedState } from './prepared-state.js';

/** At most this many alternatives are named in a "not offered" sentence. */
const MAX_ALTERNATIVES = 6;

/**
 * Would the create's own preflight (`validateSizeChoice`) accept `size` in
 * `location`? It IS that preflight, run early: size exists, available, disk
 * fits the snapshot, the snapshot is in the region (snapshots are regional),
 * the size is offered there. A refusal comes back as its first sentence plus
 * the sizes at least as big offered there. A region no size lists is refused
 * first, since the preflight cannot tell a typo from an empty list.
 */
export function digitaloceanPlacementVerdict(
  q: { size?: string; location: string },
  sizes: DigitalOceanSize[],
  snapshot: DigitalOceanSnapshot | null = null,
  /** The variant the create would boot, so a re-bake hint names that tier. */
  agents: readonly string[] = [],
): PlacementCheck {
  const size = q.size?.trim() || DIGITALOCEAN_DEFAULT_SIZE;
  const location = q.location.trim();
  const known = new Set(sizes.flatMap((s) => s.regions));
  if (known.size > 0 && !known.has(location)) {
    return {
      offered: false,
      reason: `DigitalOcean offers no size in region '${location}' (it has ${[...known].sort().join(', ')}).`,
    };
  }
  try {
    validateSizeChoice({ size, region: location }, sizes, snapshot, { agents });
    return { offered: true };
  } catch (err) {
    if (!(err instanceof UserFacingError)) throw err;
    const plan = sizes.find((s) => s.slug === size);
    const here = sizes
      .filter((s) => s.available && s.regions.includes(location))
      .filter((s) => !plan || (s.vcpus >= plan.vcpus && s.memory >= plan.memory))
      .sort((a, b) => a.vcpus - b.vcpus || a.memory - b.memory)
      .slice(0, MAX_ALTERNATIVES)
      .map((s) => s.slug);
    const first = err.message.split('\n')[0] ?? err.message;
    // A snapshot in the wrong region is not fixed by another size.
    const snapshotIssue = /snapshot/.test(first);
    return {
      offered: false,
      reason: snapshotIssue
        ? `${first} Re-bake it there: agentbox prepare --provider digitalocean --force --location ${location}.`
        : first + (here.length > 0 ? ` In ${location} you can pick ${here.join(', ')}.` : ''),
    };
  }
}

/**
 * `ProviderModule.checkPlacement` for digitalocean: GET /v2/sizes plus the
 * snapshot the create would boot (the agent's variant, else the base).
 */
export async function checkDigitalOceanPlacement(
  q: { size?: string; location: string; agents?: string[] },
  client?: DigitalOceanClient,
): Promise<PlacementCheck | null> {
  if (!q.location.trim()) return null;
  if (!client && readDigitalOceanCredStatus().source === 'none') return null;
  try {
    const c = client ?? makeDigitalOceanClient();
    const state = readPreparedState();
    const imageId = preparedImageIdFor(state, { agents: q.agents });
    const [sizes, snapshot] = await Promise.all([
      c.listSizes(),
      typeof imageId === 'number'
        ? c.getSnapshot(String(imageId)).catch(() => null)
        : Promise.resolve(null),
    ]);
    const variant = typeof imageId === 'number' ? resolvedVariantForImage(state, imageId) : '';
    return digitaloceanPlacementVerdict(q, sizes, snapshot, variant ? variant.split(',') : []);
  } catch {
    return null;
  }
}
