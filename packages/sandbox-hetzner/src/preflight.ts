/**
 * Pure Hetzner create preflight — no network. Given a fetched `/server_types`
 * catalog and (optionally) the base image, validate the user's server-type +
 * location choice BEFORE we start creating billable resources (firewall, SSH
 * key, server), and map the late provision errors Hetzner returns into
 * actionable guidance.
 *
 * Kept side-effect-free so it unit-tests against fake catalogs/images. The
 * backend fetches the catalog + image and calls in.
 */

import { UserFacingError } from '@agentbox/core';
import { HetznerApiError, type HetznerImage, type HetznerServerType } from './client.js';

export interface ServerChoice {
  serverType: string;
  location: string;
}

/** A non-deprecated x86 type is deprecated iff the `deprecation` object is set. */
function isDeprecated(t: HetznerServerType): boolean {
  return t.deprecated === true || (t.deprecation !== undefined && t.deprecation !== null);
}

/**
 * Up to `limit` non-deprecated x86 type names from the catalog, cheapest-looking
 * first (the catalog is roughly ordered by size, so preserve its order). Used to
 * suggest alternatives when the user's type is unknown.
 */
function suggestTypes(catalog: HetznerServerType[], limit = 6): string[] {
  return catalog
    .filter((t) => t.architecture === 'x86' && !isDeprecated(t))
    .map((t) => t.name)
    .slice(0, limit);
}

/** Locations (from `prices[].location`) where a given type is offered. */
function offeredLocations(t: HetznerServerType): string[] {
  const seen = new Set<string>();
  for (const p of t.prices) {
    if (p.location) seen.add(p.location);
  }
  return [...seen];
}

/**
 * Validate a server-type + location choice against the live catalog and the
 * base image, throwing a `UserFacingError` with a fix on the first problem.
 * Checks, in order: type exists → is x86 (ARM `cax*` snapshots aren't
 * supported) → not deprecated → disk fits the image → location offers the type.
 *
 * `image` is null when the box boots from a Hetzner stock image ref (a plain
 * string like `ubuntu-24.04`, not a numeric snapshot id) — the disk check is
 * skipped in that case since we don't have the image's `disk_size`.
 */
export function validateServerChoice(
  choice: ServerChoice,
  catalog: HetznerServerType[],
  image: HetznerImage | null,
): void {
  const { serverType, location } = choice;
  const type = catalog.find((t) => t.name === serverType);

  if (!type) {
    const suggestions = suggestTypes(catalog);
    const hint =
      suggestions.length > 0 ? ` Valid types include: ${suggestions.join(', ')}.` : '';
    throw new UserFacingError(
      `Hetzner server type "${serverType}" does not exist.${hint}\n` +
        'Set one with `--size <type>` or `agentbox config set box.sizeHetzner <type>`.',
    );
  }

  if (type.architecture !== 'x86') {
    throw new UserFacingError(
      `Hetzner server type "${serverType}" is ${type.architecture} (ARM). AgentBox base ` +
        'snapshots are x86-only, so ARM types (e.g. `cax*`) are not supported.\n' +
        `Pick an x86 type instead: ${suggestTypes(catalog).join(', ')}.`,
    );
  }

  if (isDeprecated(type)) {
    const after = type.deprecation?.unavailable_after;
    const when = after ? ` (unavailable after ${after})` : '';
    throw new UserFacingError(
      `Hetzner server type "${serverType}" is deprecated${when} and can't be used for new servers.\n` +
        `Pick a current type instead: ${suggestTypes(catalog).join(', ')}.`,
    );
  }

  // Snapshot disk must fit the plan's disk. Skip for stock string refs (image
  // null) — we don't have a disk_size to compare, and Hetzner sizes those itself.
  if (image && typeof image.disk_size === 'number' && type.disk < image.disk_size) {
    throw new UserFacingError(
      `Hetzner server type "${serverType}" has a ${String(type.disk)} GB disk, but the base ` +
        `snapshot needs at least ${String(image.disk_size)} GB.\n` +
        'Choose a larger type (bigger plans have bigger disks).',
    );
  }

  const locations = offeredLocations(type);
  if (locations.length > 0 && !locations.includes(location)) {
    throw new UserFacingError(
      `Hetzner server type "${serverType}" is not offered in location "${location}".\n` +
        `It is available in: ${locations.join(', ')}.\n` +
        'Pick one with `--location <name>` or `agentbox config set box.hetznerLocation <name>`.',
    );
  }
}

/**
 * Map a Hetzner provision error (from `createServer`) into a friendlier
 * `UserFacingError`, preserving the original message. Non-Hetzner errors and
 * unrecognized codes pass through unchanged so we never hide an unexpected
 * failure. Called around the `createServer` call in the backend.
 */
export function mapHetznerProvisionError(err: unknown, choice: ServerChoice): unknown {
  if (!(err instanceof HetznerApiError)) return err;
  const { serverType, location } = choice;

  if (err.code === 'resource_limit_exceeded') {
    return new UserFacingError(
      `Hetzner refused to create the server: your account resource limit was exceeded ` +
        `(${err.message}).\n` +
        'New Hetzner Cloud accounts start with a low server limit. Request an increase in ' +
        'the Hetzner Console (Limits page: https://console.hetzner.cloud/ → your project → ' +
        'Limits), then retry.',
    );
  }

  if (err.code === 'resource_unavailable' || err.code === 'placement_error') {
    return new UserFacingError(
      `Hetzner has no capacity for "${serverType}" in "${location}" right now ` +
        `(${err.message}).\n` +
        'Retry, or pick another datacenter with `--location fsn1` / `hel1` / `ash` ' +
        '(or `agentbox config set box.hetznerLocation <name>`).',
    );
  }

  return err;
}
