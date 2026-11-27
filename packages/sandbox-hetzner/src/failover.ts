/**
 * Location failover for a Hetzner server create.
 *
 * nbg1 and fsn1 regularly run out of the small shared types (cx23/cx33): the
 * create comes back `412 resource_unavailable: error during placement` while
 * the same type, from the same snapshot, creates fine in the next location.
 * So a capacity failure is retried in the other locations of the same network
 * zone before the create gives up.
 *
 * Kept to Hetzner on purpose: the CLI and the hub only ever hand the backend a
 * location and whether the user pinned it.
 *
 * What does NOT need to move with the location: the per-box firewall (Hetzner
 * firewalls are project-wide), the SSH key (cloud-init user data), the base and
 * checkpoint images (snapshots are project-wide and boot in any location) and
 * the public IPv4 (auto-assigned per server). So only the `location` field of
 * the create request changes between attempts, and a refused create leaves no
 * server behind to clean up.
 */

import { UserFacingError } from '@agentbox/core';
import {
  HetznerApiError,
  type HetznerClient,
  type HetznerDatacenter,
  type HetznerLocation,
  type HetznerServerType,
} from './client.js';

/** Hetzner's "no capacity for this type here right now" answers. */
export function isCapacityError(err: unknown): boolean {
  return (
    err instanceof HetznerApiError &&
    (err.code === 'resource_unavailable' || err.code === 'placement_error')
  );
}

export interface LocationPlanInput {
  serverType: string;
  /** The configured or explicit location: always the first attempt. */
  location: string;
  /** True when the user passed `--location` for this create: never move. */
  pinned: boolean;
  catalog: HetznerServerType[];
  /** GET /locations. Empty when it could not be fetched: no failover then. */
  locations: HetznerLocation[];
  /** GET /datacenters. Optional: without it no location is skipped for capacity. */
  datacenters?: HetznerDatacenter[];
}

export interface LocationPlan {
  /** Locations to try, in order. Never empty. */
  candidates: string[];
  /** Same-zone locations left out, with why (logged by the caller). */
  skipped: Array<{ location: string; reason: string }>;
  /** The first location's network zone, when known. */
  zone?: string;
}

/**
 * The ordered locations a create tries.
 *
 * The first location is always the configured one. After it come the other
 * locations in the SAME network zone, in the API's order; the zone is never
 * left. Crossing from eu-central to us-east/us-west/ap-southeast changes
 * latency to the user and the price, and the cx types are not offered outside
 * eu-central at all, so a silent move there would mostly fail anyway and,
 * where it worked, land a box somewhere the user did not choose.
 *
 * A later candidate is skipped when the type is not offered there (not in its
 * `prices`), or when every datacenter in it reports the type as not currently
 * available. The first location is never skipped for availability: the
 * datacenter list can lag, and a pinned location must be tried as asked.
 */
export function planLocations(input: LocationPlanInput): LocationPlan {
  const { serverType, location, pinned, catalog, locations, datacenters } = input;
  if (pinned) return { candidates: [location], skipped: [] };

  const zone = locations.find((l) => l.name === location)?.network_zone;
  if (!zone) return { candidates: [location], skipped: [] };

  const type = catalog.find((t) => t.name === serverType);
  const offered = new Set((type?.prices ?? []).map((p) => p.location));

  const candidates = [location];
  const skipped: LocationPlan['skipped'] = [];
  for (const l of locations) {
    if (l.name === location || l.network_zone !== zone) continue;
    if (offered.size > 0 && !offered.has(l.name)) {
      skipped.push({ location: l.name, reason: `${serverType} is not offered there` });
      continue;
    }
    if (type && datacenters && datacenters.length > 0) {
      const here = datacenters.filter((d) => d.location.name === l.name);
      if (here.length > 0 && !here.some((d) => d.server_types.available.includes(type.id))) {
        skipped.push({
          location: l.name,
          reason: `Hetzner reports no ${serverType} capacity there`,
        });
        continue;
      }
    }
    candidates.push(l.name);
  }
  return { candidates, skipped, zone };
}

/**
 * Locations to name in the final error: where the type is offered, outside
 * the zone that was tried (when the zone is known), and not already tried.
 */
function otherOfferedLocations(args: {
  serverType: string;
  catalog: HetznerServerType[];
  tried: readonly string[];
  zone?: string;
  locations: HetznerLocation[];
}): string[] {
  const { serverType, catalog, tried, zone, locations } = args;
  const type = catalog.find((t) => t.name === serverType);
  const zoneOf = new Map(locations.map((l) => [l.name, l.network_zone]));
  const seen = new Set<string>();
  for (const p of type?.prices ?? []) {
    if (!p.location || tried.includes(p.location)) continue;
    if (zone && zoneOf.get(p.location) === zone) continue;
    seen.add(p.location);
  }
  return [...seen];
}

/**
 * The error once every candidate refused for capacity. Lists what was tried
 * and never suggests one of those locations again.
 */
export function capacityExhaustedError(args: {
  serverType: string;
  tried: readonly string[];
  pinned: boolean;
  catalog: HetznerServerType[];
  lastError: unknown;
  /** The tried zone and the location list, when known: other zones are named as such. */
  zone?: string;
  locations?: HetznerLocation[];
}): UserFacingError {
  const { serverType, tried, pinned, catalog, lastError, zone } = args;
  const locations = args.locations ?? [];
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  const sizeHint =
    'Pick a different server type with `--size <type>` or ' +
    '`agentbox config set box.sizeHetzner <type>`.';

  if (pinned) {
    const loc = tried[0] ?? '';
    const others = otherOfferedLocations({ serverType, catalog, tried, locations });
    return new UserFacingError(
      `Hetzner has no capacity for "${serverType}" in "${loc}" right now (${detail}).\n` +
        `\`--location ${loc}\` pins the box there, so no other location was tried. ` +
        'Leave `--location` out to let the create fail over to another location' +
        (others.length > 0 ? `, or pin a different one (${others.join(', ')}).` : '.') +
        `\n${sizeHint}`,
    );
  }

  const elsewhere = otherOfferedLocations({ serverType, catalog, tried, zone, locations });
  const locHint =
    elsewhere.length === 0
      ? ''
      : `\nOr choose another location (${elsewhere.join(', ')}) with \`--location <name>\` or ` +
        '`agentbox config set box.hetznerLocation <name>`.' +
        (zone ? ` Those are outside ${zone}, so latency and price differ.` : '');
  return new UserFacingError(
    `Hetzner has no capacity for "${serverType}" right now in any of: ${tried.join(', ')} ` +
      `(last error: ${detail}).\n${sizeHint}${locHint}`,
  );
}

export interface FailoverCreateArgs<T> {
  serverType: string;
  /** The configured or explicit location: always the first attempt. */
  location: string;
  pinned: boolean;
  catalog: HetznerServerType[];
  /**
   * The failover plan, loaded only after the first location refuses for
   * capacity, so a normal create pays no extra API calls. Never called when
   * pinned.
   */
  loadPlan: () => Promise<{ plan: LocationPlan; locations: HetznerLocation[] }>;
  /** One create attempt in `location`. Throws the raw Hetzner error. */
  attempt: (location: string) => Promise<T>;
  /** Maps a non-capacity error (account limit, ...) to its user-facing form. */
  mapError: (err: unknown, location: string) => unknown;
  onLog: (line: string) => void;
}

/**
 * Try `location`; on a capacity refusal load the plan and walk its remaining
 * candidates until one is not refused for capacity. Any other error stops at
 * once: an account limit or a bad request fails the same way everywhere.
 */
export async function createWithLocationFailover<T>(
  args: FailoverCreateArgs<T>,
): Promise<{ result: T; location: string; tried: string[] }> {
  const { serverType, location, pinned, catalog, loadPlan, attempt, mapError, onLog } = args;
  const tried: string[] = [];
  let lastError: unknown;
  const tryOne = async (loc: string): Promise<{ ok: true; result: T } | { ok: false }> => {
    try {
      return { ok: true, result: await attempt(loc) };
    } catch (err) {
      if (!isCapacityError(err)) throw mapError(err, loc);
      tried.push(loc);
      lastError = err;
      return { ok: false };
    }
  };

  const first = await tryOne(location);
  if (first.ok) return { result: first.result, location, tried: [location] };
  if (pinned) {
    throw capacityExhaustedError({ serverType, tried, pinned, catalog, lastError });
  }

  const { plan, locations } = await loadPlan();
  for (const sk of plan.skipped) onLog(`hetzner: skipping ${sk.location}: ${sk.reason}`);
  for (const loc of plan.candidates) {
    if (tried.includes(loc)) continue;
    onLog(`hetzner: no ${serverType} capacity in ${tried[tried.length - 1] ?? ''}, trying ${loc}`);
    const r = await tryOne(loc);
    if (r.ok) return { result: r.result, location: loc, tried: [...tried, loc] };
  }
  throw capacityExhaustedError({
    serverType,
    tried,
    pinned,
    catalog,
    lastError,
    ...(plan.zone ? { zone: plan.zone } : {}),
    locations,
  });
}

/**
 * Fetch what the plan needs. Best-effort: a failed lookup only means no
 * failover (or no availability skip), never a failed create.
 */
export async function fetchLocationPlanInputs(
  c: Pick<HetznerClient, 'listLocations' | 'listDatacenters'>,
): Promise<{ locations: HetznerLocation[]; datacenters: HetznerDatacenter[] }> {
  const [locations, datacenters] = await Promise.all([
    c.listLocations().catch(() => [] as HetznerLocation[]),
    c.listDatacenters().catch(() => [] as HetznerDatacenter[]),
  ]);
  return { locations, datacenters };
}
