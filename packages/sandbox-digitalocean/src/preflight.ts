/**
 * Pure DigitalOcean create preflight — no network. Given a fetched `/sizes`
 * catalog and (optionally) the base snapshot, validate the user's size +
 * region choice BEFORE we start creating billable resources (firewall, SSH
 * key, droplet), and map the late provision errors DigitalOcean returns into
 * actionable guidance.
 *
 * Kept side-effect-free so it unit-tests against fake catalogs/snapshots. The
 * backend fetches the catalog + snapshot and calls in. Mirrors the Hetzner
 * `preflight.ts`.
 */

import { UserFacingError } from '@agentbox/core';
import {
  DigitalOceanApiError,
  type DigitalOceanProject,
  type DigitalOceanSize,
  type DigitalOceanSnapshot,
} from './client.js';

export interface SizeChoice {
  size: string;
  region: string;
}

/**
 * Up to `limit` available size slugs from the catalog, in catalog order (DO
 * roughly orders `/sizes` cheapest-first). Used to suggest alternatives when
 * the user's slug is unknown.
 */
function suggestSizes(catalog: DigitalOceanSize[], limit = 6): string[] {
  return catalog
    .filter((s) => s.available)
    .map((s) => s.slug)
    .slice(0, limit);
}

/**
 * Validate a size + region choice against the live catalog and the base
 * snapshot, throwing a `UserFacingError` with a fix on the first problem.
 * Checks, in order: size exists → is available → disk fits the snapshot →
 * region offers the size.
 *
 * `snapshot` is null when the box boots from a DigitalOcean stock image slug
 * (a plain string like `ubuntu-24-04-x64`, not a numeric snapshot id) — the
 * disk check is skipped in that case since we don't have the `min_disk_size`.
 */
export function validateSizeChoice(
  choice: SizeChoice,
  catalog: DigitalOceanSize[],
  snapshot: DigitalOceanSnapshot | null,
): void {
  const { size, region } = choice;
  const plan = catalog.find((s) => s.slug === size);

  if (!plan) {
    const suggestions = suggestSizes(catalog);
    const hint = suggestions.length > 0 ? ` Valid sizes include: ${suggestions.join(', ')}.` : '';
    throw new UserFacingError(
      `DigitalOcean size "${size}" does not exist.${hint}\n` +
        'Set one with `--size <slug>` or `agentbox config set box.sizeDigitalocean <slug>`.',
    );
  }

  if (!plan.available) {
    throw new UserFacingError(
      `DigitalOcean size "${size}" is not currently available for new Droplets.\n` +
        `Pick an available size instead: ${suggestSizes(catalog).join(', ')}.`,
    );
  }

  // Snapshot disk must fit the plan's disk. Skip for stock string refs
  // (snapshot null) — DO sizes those itself.
  if (snapshot && typeof snapshot.min_disk_size === 'number' && plan.disk < snapshot.min_disk_size) {
    throw new UserFacingError(
      `DigitalOcean size "${size}" has a ${String(plan.disk)} GB disk, but the base ` +
        `snapshot needs at least ${String(snapshot.min_disk_size)} GB.\n` +
        'Choose a larger size (bigger plans have bigger disks).',
    );
  }

  if (plan.regions.length > 0 && !plan.regions.includes(region)) {
    throw new UserFacingError(
      `DigitalOcean size "${size}" is not offered in region "${region}".\n` +
        `It is available in: ${plan.regions.join(', ')}.\n` +
        'Pick one with `--location <slug>` or `agentbox config set box.digitaloceanRegion <slug>`.',
    );
  }
}

/**
 * Resolve `box.digitaloceanProject` (a project **name or id**) to a project id,
 * throwing a `UserFacingError` listing the real projects when it matches
 * nothing.
 *
 * This runs in the create preflight, before any billable resource exists,
 * because the assignment itself cannot: DigitalOcean has no project field on
 * droplet-create, so the assign only happens once the Droplet is up — far too
 * late to tell someone they typed the project name wrong.
 *
 * Name matching is case-insensitive; an exact id match wins over a name match so
 * a project literally named like another's id can't shadow it.
 */
export function resolveProjectChoice(project: string, projects: DigitalOceanProject[]): string {
  const wanted = project.trim();
  if (wanted.length === 0) {
    throw new UserFacingError('DigitalOcean project must not be empty.');
  }

  const byId = projects.find((p) => p.id === wanted);
  if (byId) return byId.id;

  const matches = projects.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (matches.length === 1) return matches[0]!.id;

  if (matches.length > 1) {
    throw new UserFacingError(
      `DigitalOcean project name "${wanted}" is ambiguous — ${String(matches.length)} projects share it.\n` +
        `Use the id instead: ${matches.map((p) => p.id).join(', ')}.\n` +
        'Set it with `agentbox config set box.digitaloceanProject <id>`.',
    );
  }

  const known = projects
    .map((p) => (p.is_default ? `${p.name} (default)` : p.name))
    .join(', ');
  throw new UserFacingError(
    `DigitalOcean project "${wanted}" not found on this account.\n` +
      (known.length > 0 ? `Your projects: ${known}.\n` : 'This account has no projects.\n') +
      'Set it with `agentbox config set box.digitaloceanProject <name|id>`, ' +
      'or unset it to use the account default.',
  );
}

/**
 * Map a DigitalOcean provision error (from `createDroplet`) into a friendlier
 * `UserFacingError`, preserving the original message. Non-DO errors and
 * unrecognized codes pass through unchanged so we never hide an unexpected
 * failure. Called around the `createDroplet` call in the backend.
 */
export function mapDigitalOceanProvisionError(err: unknown, choice: SizeChoice): unknown {
  if (!(err instanceof DigitalOceanApiError)) return err;
  const { size, region } = choice;
  const msg = err.message.toLowerCase();

  // DO reports the account droplet limit as a 422 with a message rather than a
  // stable machine code, so match on the text.
  if (msg.includes('droplet limit') || msg.includes('exceeded your droplet limit')) {
    return new UserFacingError(
      `DigitalOcean refused to create the Droplet: your account Droplet limit was exceeded ` +
        `(${err.message}).\n` +
        'New accounts start with a low Droplet limit. Request an increase in the DigitalOcean ' +
        'Console (Account → your team → Droplet limit), then retry.',
    );
  }

  if (msg.includes('not available') || msg.includes('capacity') || msg.includes('sold out')) {
    return new UserFacingError(
      `DigitalOcean has no capacity for "${size}" in "${region}" right now ` +
        `(${err.message}).\n` +
        'Retry, or pick another region with `--location <slug>` (e.g. `nyc1`, `sfo3`, `ams3`, ' +
        '`fra1`) or `agentbox config set box.digitaloceanRegion <slug>`.',
    );
  }

  return err;
}
