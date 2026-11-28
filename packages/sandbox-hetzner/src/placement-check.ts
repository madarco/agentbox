import { UserFacingError } from '@agentbox/core';
import { agentSetArg, normalizeAgentSet, type PlacementCheck } from '@agentbox/sandbox-core';
import { HETZNER_DEFAULT_SERVER_TYPE } from './backend.js';
import { readHetznerCredStatus } from './credentials.js';
import {
  makeHetznerClient,
  type HetznerClient,
  type HetznerImage,
  type HetznerServerType,
} from './client.js';
import { offeredLocations, validateServerChoice } from './preflight.js';
import { preparedEntryFor, readPreparedState } from './prepared-state.js';

/** At most this many alternatives are named in a "not offered" sentence. */
const MAX_ALTERNATIVES = 6;

/**
 * Would the create's own preflight (`validateServerChoice`) accept `size` at
 * `location`? It IS that preflight, run early: type exists, x86, not
 * deprecated, disk fits the snapshot, offered at the location. A refusal comes
 * back as its sentence plus the x86 types offered there. A location missing
 * from `locations` is refused first, since the preflight does not know them.
 */
export function hetznerPlacementVerdict(
  q: { size?: string; location: string },
  types: HetznerServerType[],
  locations: string[],
  image: HetznerImage | null = null,
): PlacementCheck {
  const serverType = q.size?.trim() || HETZNER_DEFAULT_SERVER_TYPE;
  const location = q.location.trim();
  if (locations.length > 0 && !locations.includes(location)) {
    return {
      offered: false,
      reason: `Hetzner has no location '${location}' (it has ${locations.join(', ')}).`,
    };
  }
  try {
    validateServerChoice({ serverType, location }, types, image);
    return { offered: true };
  } catch (err) {
    if (!(err instanceof UserFacingError)) throw err;
    const here = types
      .filter(
        (t) =>
          t.architecture === 'x86' &&
          !t.deprecation &&
          offeredLocations(t).includes(location) &&
          (!image?.disk_size || t.disk >= image.disk_size),
      )
      .sort((a, b) => a.cores - b.cores || a.memory - b.memory)
      .slice(0, MAX_ALTERNATIVES)
      .map((t) => t.name);
    const first = err.message.split('\n')[0] ?? err.message;
    return {
      offered: false,
      reason: first + (here.length > 0 ? ` In ${location} you can pick ${here.join(', ')}.` : ''),
    };
  }
}

/**
 * `ProviderModule.checkPlacement` for hetzner: GET /server_types + /locations,
 * plus the snapshot the create would boot (the agent's variant, else the base)
 * for the disk check.
 */
export async function checkHetznerPlacement(
  q: { size?: string; location: string; agents?: string[] },
  client?: HetznerClient,
): Promise<PlacementCheck | null> {
  if (!q.location.trim()) return null;
  if (!client && readHetznerCredStatus().source === 'none') return null;
  try {
    const c = client ?? makeHetznerClient();
    const state = readPreparedState();
    const entry =
      preparedEntryFor(state, agentSetArg(normalizeAgentSet(q.agents))) ?? preparedEntryFor(state);
    const [types, locations, image] = await Promise.all([
      c.listServerTypes(),
      c.listLocations(),
      entry ? c.getImage(entry.imageId).catch(() => null) : Promise.resolve(null),
    ]);
    return hetznerPlacementVerdict(
      q,
      types,
      locations.map((l) => l.name),
      image,
    );
  } catch {
    return null;
  }
}
