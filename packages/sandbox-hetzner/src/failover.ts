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
  type HetznerLocation,
  type HetznerServerType,
} from './client.js';
import { offeredLocations } from './preflight.js';

/**
 * Hetzner's "no capacity for this type here right now" answers.
 *
 * `resource_unavailable` is also what Hetzner returns for a few non-capacity
 * shortages (an exhausted IPv4 pool, for one). Retrying those in another
 * location is harmless and bounded: at most one attempt per location in one
 * zone (three in eu-central), and the final error still carries the original
 * message.
 */
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
  /** GET /server_types: `locations[]` says where each type is offered. */
  catalog: HetznerServerType[];
  /** GET /locations. Empty when it could not be fetched: no failover then. */
  locations: HetznerLocation[];
}

export interface LocationPlan {
  /** Locations to try, in order. Never empty. */
  candidates: string[];
  /** Same-zone locations left out, with why (logged by the caller). */
  skipped: Array<{ location: string; reason: string }>;
  /** The first location's network zone, when known. */
  zone?: string;
}

/** 0 = available + recommended, 1 = available, 2 = no hint or `available: false`. */
function availabilityRank(type: HetznerServerType | undefined, location: string): number {
  const entry = type?.locations?.find((l) => l.name === location);
  if (entry?.available === true) return entry.recommended === true ? 0 : 1;
  return 2;
}

/**
 * The ordered locations a create tries.
 *
 * The first location is always the configured one. After it come the other
 * locations in the SAME network zone; the zone is never left. Crossing from
 * eu-central to us-east/us-west/ap-southeast changes latency to the user and
 * the price, and the cx types are not offered outside eu-central at all, so a
 * silent move there would mostly fail anyway and, where it worked, land a box
 * somewhere the user did not choose.
 *
 * A later location is left out only when the type is not offered there (absent
 * from `server_types[].locations`, or deprecated there). Hetzner's `available`
 * / `recommended` hints only ORDER the rest: available and recommended first,
 * then available, then everything else in API order. They never rule a location
 * out, because creates succeed in locations reported `available: false` (cx33
 * in hel1, measured 2026-11-27, while every EU location reported it false); one
 * real create per offered location is the only ground truth.
 */
export function planLocations(input: LocationPlanInput): LocationPlan {
  const { serverType, location, pinned, catalog, locations } = input;
  if (pinned) return { candidates: [location], skipped: [] };

  const zone = locations.find((l) => l.name === location)?.network_zone;
  if (!zone) return { candidates: [location], skipped: [] };

  const type = catalog.find((t) => t.name === serverType);
  const offered = new Set(type ? offeredLocations(type) : []);

  const rest: string[] = [];
  const skipped: LocationPlan['skipped'] = [];
  for (const l of locations) {
    if (l.name === location || l.network_zone !== zone) continue;
    if (offered.size > 0 && !offered.has(l.name)) {
      skipped.push({ location: l.name, reason: `${serverType} is not offered there` });
      continue;
    }
    rest.push(l.name);
  }
  // Array.prototype.sort is stable, so equal ranks keep the API's order.
  rest.sort((a, b) => availabilityRank(type, a) - availabilityRank(type, b));
  return { candidates: [location, ...rest], skipped, zone };
}

/**
 * Types of the same size class (vCPU + RAM) Hetzner reports available in one
 * of `where`: the final error names them so the user can switch, never the
 * create itself. Typically the cpx sibling of a sold-out cx type.
 */
function equivalentAvailableTypes(
  serverType: string,
  catalog: HetznerServerType[],
  where: readonly string[],
): Array<{ name: string; location: string }> {
  const type = catalog.find((t) => t.name === serverType);
  if (!type) return [];
  const out: Array<{ name: string; location: string }> = [];
  for (const t of catalog) {
    if (t.name === serverType || t.architecture !== 'x86') continue;
    if (t.deprecated === true || (t.deprecation !== undefined && t.deprecation !== null)) continue;
    if (t.cores !== type.cores || t.memory !== type.memory) continue;
    const at = (t.locations ?? []).find(
      (l) => l.available === true && !l.deprecation && where.includes(l.name),
    );
    if (at) out.push({ name: t.name, location: at.name });
  }
  return out;
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
  for (const loc of type ? offeredLocations(type) : []) {
    if (tried.includes(loc)) continue;
    if (zone && zoneOf.get(loc) === zone) continue;
    seen.add(loc);
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
  const alt = equivalentAvailableTypes(serverType, catalog, tried)[0];
  const sizeHint =
    (alt
      ? `${alt.name} (same vCPU/RAM) is reported available in ${alt.location}; try \`--size ${alt.name}\`. Otherwise pick`
      : 'Pick') +
    ' a different server type with `--size <type>` or ' +
    '`agentbox config set box.sizeHetzner <type>`.';

  if (pinned) {
    const loc = tried[0] ?? '';
    const others = otherOfferedLocations({ serverType, catalog, tried, locations });
    return new UserFacingError(
      `Hetzner has no capacity for "${serverType}" in "${loc}" right now (${detail}).\n` +
        `The location was pinned (\`--location ${loc}\`), so no other location was tried. ` +
        'Leave the location unpinned to let the create fail over to another one' +
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
 * Fetch the location list the plan needs. Best-effort: a failed lookup only
 * means no failover, never a failed create.
 */
export async function fetchLocations(
  c: Pick<HetznerClient, 'listLocations'>,
): Promise<HetznerLocation[]> {
  return c.listLocations().catch(() => []);
}
