import { isCancel, log, select, text } from '@clack/prompts';
import { PROVIDERS, regionDefaultSize, type ProviderRegion } from '@agentbox/config';
import {
  CONTROL_PLANE_DEFAULT_REGION,
  CONTROL_PLANE_DEFAULT_SIZE,
  controlPlanePlacementWarnings as digitaloceanPlacementWarnings,
  readDigitalOceanCredStatus,
} from '@agentbox/sandbox-digitalocean';
import {
  CONTROL_PLANE_DEFAULT_LOCATION,
  CONTROL_PLANE_DEFAULT_SERVER_TYPE,
  controlPlanePlacementWarnings as hetznerPlacementWarnings,
  readHetznerCredStatus,
} from '@agentbox/sandbox-hetzner';

/**
 * Where and how big the control-box VPS is: the `--location` / `--size` of
 * `hub setup` and `hub deploy hetzner|digitalocean`. Both are opaque strings for
 * the target cloud (a Hetzner location + server type, a DigitalOcean region +
 * size slug), offered from the same descriptor lists the create pickers use.
 */
export type VpsTarget = 'hetzner' | 'digitalocean';

export interface VpsPlacement {
  location: string;
  size: string;
}

/**
 * The control-box defaults, owned by the package deploys. The default size is
 * also the floor: the VPS runs the hub and docker, and has never been measured
 * on less than 2 vCPU / 4 GB.
 */
export const VPS_DEFAULTS: Record<VpsTarget, VpsPlacement> = {
  hetzner: { location: CONTROL_PLANE_DEFAULT_LOCATION, size: CONTROL_PLANE_DEFAULT_SERVER_TYPE },
  digitalocean: { location: CONTROL_PLANE_DEFAULT_REGION, size: CONTROL_PLANE_DEFAULT_SIZE },
};

/** The default size for a target at a location: the region's own first size, else the default. */
export function defaultSizeFor(target: VpsTarget, location: string): string {
  return regionDefaultSize(descriptorOf(target), location) ?? VPS_DEFAULTS[target].size;
}

/** The provider package's warnings for this placement (floor, Arm, not offered there). */
export function placementWarnings(target: VpsTarget, size: string, location: string): string[] {
  return target === 'hetzner'
    ? hetznerPlacementWarnings(size, location)
    : digitaloceanPlacementWarnings(size);
}

/** The error for a deploy target with no cloud credential here, or null. */
export function vpsCredentialError(target: VpsTarget): string | null {
  if (target === 'hetzner') {
    return readHetznerCredStatus().source === 'none'
      ? 'no HCLOUD_TOKEN configured — run `agentbox hetzner login` first'
      : null;
  }
  return readDigitalOceanCredStatus().source === 'none'
    ? 'no DIGITALOCEAN_TOKEN configured — run `agentbox digitalocean login` first'
    : null;
}

function descriptorOf(target: VpsTarget) {
  const d = PROVIDERS.find((p) => p.name === target);
  if (!d) throw new Error(`no provider descriptor for ${target}`);
  return d as (typeof PROVIDERS)[number] & {
    sizes?: readonly { key: string; label: string }[];
    sizeHint?: string;
    regions?: readonly ProviderRegion[];
    regionHint?: string;
  };
}

const CUSTOM = '__custom__';

/**
 * One clack `select` over `choices` with `initial` preselected, plus a
 * "Custom..." entry when `hint` exists (the descriptor's open-list signal).
 * Returns null on cancel.
 */
async function pick(
  message: string,
  choices: readonly { key: string; label: string }[],
  initial: string,
  hint: string | undefined,
): Promise<string | null> {
  const options = choices.map((c) => ({ value: c.key, label: c.label }));
  if (!options.some((o) => o.value === initial))
    options.unshift({ value: initial, label: initial });
  if (hint) options.push({ value: CUSTOM, label: 'Custom...' });
  const choice = await select({ message, options, initialValue: initial });
  if (isCancel(choice)) return null;
  if (choice !== CUSTOM) return String(choice);
  const typed = await text({
    message,
    placeholder: hint,
    validate: (v) => (v && v.trim().length > 0 ? undefined : 'enter a value'),
  });
  if (isCancel(typed)) return null;
  return String(typed).trim();
}

/**
 * The location + size a VPS deploy uses: a flag wins, else (interactive) a
 * prompt from the descriptor lists with the default preselected, else the
 * default. The size default and choices follow the location (Hetzner). Returns
 * null when the user cancels a prompt. Warns, never refuses, on a size below
 * the floor or one the location does not offer.
 */
export async function resolveVpsPlacement(
  target: VpsTarget,
  flags: { location?: string; size?: string },
  interactive: boolean,
): Promise<VpsPlacement | null> {
  const d = descriptorOf(target);
  // Lowercased: the clouds' names are lowercase and the descriptor keys too,
  // so `ASH` would match nothing here and reach the API as is.
  let location = flags.location?.trim().toLowerCase() || '';
  let size = flags.size?.trim() || '';
  if (!location) {
    if (interactive) {
      const picked = await pick(
        `${d.label}: location for the control box`,
        d.regions ?? [],
        VPS_DEFAULTS[target].location,
        d.regionHint,
      );
      if (picked === null) return null;
      location = picked.toLowerCase();
    } else {
      location = VPS_DEFAULTS[target].location;
    }
  }
  if (!size) {
    const fallback = defaultSizeFor(target, location);
    if (interactive) {
      // A region that does not offer the provider's own sizes lists its own.
      const choices = d.regions?.find((r) => r.key === location)?.sizes ?? d.sizes ?? [];
      const picked = await pick(
        `${d.label}: size for the control box`,
        choices,
        fallback,
        d.sizeHint,
      );
      if (picked === null) return null;
      size = picked;
    } else {
      size = fallback;
    }
  }
  for (const w of placementWarnings(target, size, location)) log.warn(w);
  return { location, size };
}
