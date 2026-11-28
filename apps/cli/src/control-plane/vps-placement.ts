import { isCancel, log, select, text } from '@clack/prompts';
import { PROVIDERS } from '@agentbox/config';
import {
  CONTROL_PLANE_DEFAULT_REGION,
  CONTROL_PLANE_DEFAULT_SIZE,
  readDigitalOceanCredStatus,
} from '@agentbox/sandbox-digitalocean';
import {
  CONTROL_PLANE_DEFAULT_LOCATION,
  CONTROL_PLANE_DEFAULT_SERVER_TYPE,
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

const FLOOR = { vcpus: 2, memoryGb: 4 };

/**
 * Hetzner's shared x86 lines are each offered in a subset of locations
 * (GET /server_types, measured 2026-11-28): `cx` in eu-central only, `cpx?1` in
 * the US only, `cpx?2` in eu-central and Singapore. `ccx` is everywhere. So the
 * default `cx23` cannot follow a user to ash/hil/sin, and those locations get a
 * floor-sized sibling instead.
 */
const HETZNER_EU = new Set(['nbg1', 'fsn1', 'hel1']);
const HETZNER_US = new Set(['ash', 'hil']);

const HETZNER_SIZES_BY_AREA: Record<
  'eu' | 'us' | 'sin',
  { key: string; label: string }[] | undefined
> = {
  // eu: the descriptor's cx list.
  eu: undefined,
  us: [
    { key: 'cpx21', label: 'cpx21 - 3 vCPU / 4 GB (default here)' },
    { key: 'cpx31', label: 'cpx31 - 4 vCPU / 8 GB' },
    { key: 'cpx41', label: 'cpx41 - 8 vCPU / 16 GB' },
  ],
  sin: [
    { key: 'cpx22', label: 'cpx22 - 2 vCPU / 4 GB (default here)' },
    { key: 'cpx32', label: 'cpx32 - 4 vCPU / 8 GB' },
    { key: 'cpx42', label: 'cpx42 - 8 vCPU / 16 GB' },
  ],
};

function hetznerArea(location: string): 'eu' | 'us' | 'sin' | null {
  const l = location.trim().toLowerCase();
  if (HETZNER_EU.has(l)) return 'eu';
  if (HETZNER_US.has(l)) return 'us';
  if (l === 'sin') return 'sin';
  return null;
}

/** The default size for a target at a location (Hetzner's cx23 is EU-only). */
export function defaultSizeFor(target: VpsTarget, location: string): string {
  if (target === 'hetzner') {
    const sizes = HETZNER_SIZES_BY_AREA[hetznerArea(location) ?? 'eu'];
    if (sizes?.[0]) return sizes[0].key;
  }
  return VPS_DEFAULTS[target].size;
}

/**
 * The warning for a Hetzner type the static table says is not offered at
 * `location`, or null. A warning, not a refusal: the table can drift from the
 * live catalog, and Hetzner's own create error is the ground truth.
 */
export function hetznerLocationWarning(size: string, location: string): string | null {
  const s = size.trim().toLowerCase();
  const area = hetznerArea(location);
  if (!area) return null;
  const offered = /^cx\d/.test(s)
    ? area === 'eu'
    : /^cpx\d1$/.test(s)
      ? area === 'us'
      : /^cpx\d2$/.test(s)
        ? area !== 'us'
        : true;
  if (offered) return null;
  return (
    `Hetzner does not offer ${size} in ${location}, so the create will likely fail. ` +
    `Use ${defaultSizeFor('hetzner', location)} there (or a ccx type, offered everywhere).`
  );
}

// Hetzner x86 types under the floor (live catalog, 2026-11-28, plus the retired
// cx11). Opaque slugs carry no shape, so an unlisted type is assumed big enough.
const HETZNER_SMALL: Record<string, string> = {
  cx11: '1 vCPU / 2 GB',
  cpx02: '1 vCPU / 1 GB',
  cpx11: '2 vCPU / 2 GB',
  cpx12: '1 vCPU / 2 GB',
};

/**
 * The warning for a size below what the control box needs, or null. Hetzner
 * reads the list of known smaller types; DigitalOcean slugs spell their shape
 * (`s-1vcpu-2gb`). The Arm `cax` line warns at any size: the hub is deployed
 * for amd64.
 */
export function hubSizeWarning(target: VpsTarget, size: string): string | null {
  const s = size.trim().toLowerCase();
  const floor = `${VPS_DEFAULTS[target].size} (${String(FLOOR.vcpus)} vCPU / ${String(FLOOR.memoryGb)} GB)`;
  if (target === 'hetzner') {
    if (/^cax/.test(s)) {
      return `${size} is an Arm server type; the control box is deployed for amd64. Use ${floor} or larger.`;
    }
    const small = HETZNER_SMALL[s];
    if (small) {
      return `${size} (${small}) is below what the control box needs (it runs the hub and docker). Use ${floor} or larger.`;
    }
    return null;
  }
  const m = /(\d+)vcpu-(\d+)(gb|mb)/.exec(s);
  if (!m) return null;
  const vcpus = Number(m[1]);
  const memoryGb = m[3] === 'mb' ? Number(m[2]) / 1024 : Number(m[2]);
  if (vcpus >= FLOOR.vcpus && memoryGb >= FLOOR.memoryGb) return null;
  return `${size} is below what the control box needs (it runs the hub and docker). Use ${floor} or larger.`;
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
    regions?: readonly { key: string; label: string }[];
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
  let location = flags.location?.trim() || '';
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
      location = picked;
    } else {
      location = VPS_DEFAULTS[target].location;
    }
  }
  if (!size) {
    const fallback = defaultSizeFor(target, location);
    if (interactive) {
      const area = target === 'hetzner' ? hetznerArea(location) : null;
      const choices = (area ? HETZNER_SIZES_BY_AREA[area] : undefined) ?? d.sizes ?? [];
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
  const warnings = [
    hubSizeWarning(target, size),
    target === 'hetzner' ? hetznerLocationWarning(size, location) : null,
  ];
  for (const w of warnings) if (w) log.warn(w);
  return { location, size };
}
