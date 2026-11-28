import { PROVIDERS, regionDefaultSize, type ProviderRegion } from '@agentbox/config';

/**
 * Hetzner's placement knowledge, kept here rather than in any client: which
 * server type a location defaults to, and the static "is this type offered
 * there / big enough for the control box" warnings. The per-location size lists
 * themselves live on the descriptor (`regions[].sizes`), so UIs read them from
 * `/api/v1/providers` without loading this package.
 */

/** Must match `HETZNER_DEFAULT_SERVER_TYPE` (backend.ts); a test pins both. */
const EU_DEFAULT = 'cx23';

function hetznerRegions(): readonly ProviderRegion[] {
  const d = PROVIDERS.find((p) => p.name === 'hetzner') as
    | { regions?: readonly ProviderRegion[] }
    | undefined;
  return d?.regions ?? [];
}

/**
 * The server type a box (or the control box) gets in `location` when no size
 * is asked for: the location's own first size where it declares one (cx is
 * EU-only, so ash/hil/sin each have their own), else cx23.
 */
export function defaultServerTypeFor(location: string | undefined): string {
  return regionDefaultSize({ regions: hetznerRegions() }, location) ?? EU_DEFAULT;
}

const EU = new Set(['nbg1', 'fsn1', 'hel1']);
const US = new Set(['ash', 'hil']);

/**
 * Whether the shared x86 line `serverType` belongs to is offered at `location`
 * (GET /server_types, measured 2026-11-28): cx in eu-central only, cpx?1 in the
 * US only, cpx?2 in eu-central and Singapore. Null = no rule for this type or
 * location (ccx is everywhere; an unknown location is not second-guessed).
 */
export function lineOfferedAt(serverType: string, location: string): boolean | null {
  const s = serverType.trim().toLowerCase();
  const l = location.trim().toLowerCase();
  const area = EU.has(l) ? 'eu' : US.has(l) ? 'us' : l === 'sin' ? 'sin' : null;
  if (!area) return null;
  if (/^cx\d/.test(s)) return area === 'eu';
  if (/^cpx\d1$/.test(s)) return area === 'us';
  if (/^cpx\d2$/.test(s)) return area !== 'us';
  return null;
}

// x86 types under the control box's 2 vCPU / 4 GB floor (live catalog,
// 2026-11-28, plus the retired cx11). An unlisted type is assumed big enough.
const UNDER_FLOOR: Record<string, string> = {
  cx11: '1 vCPU / 2 GB',
  cpx02: '1 vCPU / 1 GB',
  cpx11: '2 vCPU / 2 GB',
  cpx12: '1 vCPU / 2 GB',
};

/**
 * Warnings for a control-box `serverType` at `location`: Arm (the hub is
 * deployed for amd64), under the floor, or a line the location does not offer.
 * Warnings, not refusals: the static rules can drift from the live catalog.
 */
export function controlPlanePlacementWarnings(serverType: string, location: string): string[] {
  const s = serverType.trim().toLowerCase();
  const floor = `${EU_DEFAULT} (2 vCPU / 4 GB)`;
  const out: string[] = [];
  if (/^cax/.test(s)) {
    out.push(
      `${serverType} is an Arm server type; the control box is deployed for amd64. Use ${floor} or larger.`,
    );
  } else if (UNDER_FLOOR[s]) {
    out.push(
      `${serverType} (${UNDER_FLOOR[s]}) is below what the control box needs (it runs the hub and docker). Use ${floor} or larger.`,
    );
  }
  if (lineOfferedAt(s, location) === false) {
    out.push(
      `Hetzner does not offer ${serverType} in ${location}, so the create will likely fail. ` +
        `Use ${defaultServerTypeFor(location)} there (or a ccx type, offered everywhere).`,
    );
  }
  return out;
}
