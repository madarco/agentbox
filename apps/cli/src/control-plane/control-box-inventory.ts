/**
 * The control box's own provider inventory — the ONE reading of
 * `GET /api/v1/providers?freshness=1` that both `agentbox prepare --status` /
 * `doctor` (text) and `doctor --json` (the menu-bar app's source) render.
 *
 * The local provider rows of either report describe THIS machine; with a control
 * box configured it is the control box's bakes a cloud create boots from, so a
 * consumer that cannot tell the two machines apart silently reports the wrong one.
 */

import type { HubApiProvider } from './hub-api-client.js';

/** One cloud provider as the control box reports it. */
export interface ControlBoxProviderRow {
  id: string;
  /** The control box holds credentials for it. */
  hasCredentials: boolean;
  /** Its base is baked there (a create can boot from it). */
  configured: boolean;
  /** Freshness of that bake against the CONTROL BOX's build context. */
  baseStatus?: 'fresh' | 'stale' | 'unprepared' | 'unknown';
  /** The one-word state the text report prints for this row, so both agree. */
  state: string;
}

/**
 * Present whenever a genuinely remote control box is configured — including when
 * it cannot be reached, which is carried as `reachable: false` rather than by
 * omission: absent has to mean "no control box", or a consumer reading only the
 * local rows would never learn that a second machine exists.
 */
export interface ControlBoxInventory {
  url: string;
  reachable: boolean;
  /** Why the inventory is empty, when `reachable` is false. */
  error?: string;
  providers: ControlBoxProviderRow[];
}

/** IO the inventory needs, injected so the decision itself is unit-testable. */
export interface ControlBoxInventoryDeps {
  /** True for a local hub or `hub expose` here — then there is nothing to report. */
  coLocated: () => Promise<boolean>;
  /** The configured hub target, or null when none resolves. */
  target: () => Promise<{ url: string } | null>;
  /** Cheap owned-socket probe before spending the fetch budget. */
  reachable: (url: string) => Promise<boolean>;
  /** `GET /api/v1/providers?freshness=1`, or null when it failed. */
  listProviders: () => Promise<HubApiProvider[] | null>;
}

const UNREACHABLE = 'could not read its baked providers';

/** The state word a row reads as — credentials first, then bake, then freshness. */
function providerState(p: HubApiProvider): string {
  if (!p.hasCredentials) return 'no credentials';
  if (!p.configured) return 'not baked';
  return p.baseStatus ?? 'baked';
}

/** Docker-family providers are a local engine's business, never the control box's. */
function isCloudProvider(p: HubApiProvider): boolean {
  return p.id !== 'docker' && p.id !== 'remote-docker';
}

/**
 * The inventory, or null when there is nothing to report: no control box, or one
 * that IS this machine. Never throws and never blocks past the caller's probe
 * budget — both `doctor` and `prepare --status` must stay scriptable.
 */
export async function buildControlBoxInventory(
  deps: ControlBoxInventoryDeps,
): Promise<ControlBoxInventory | null> {
  if (await deps.coLocated()) return null;
  const target = await deps.target();
  if (!target) return null;
  if (!(await deps.reachable(target.url))) {
    return { url: target.url, reachable: false, error: UNREACHABLE, providers: [] };
  }
  const providers = await deps.listProviders();
  if (!providers) return { url: target.url, reachable: false, error: UNREACHABLE, providers: [] };
  return {
    url: target.url,
    reachable: true,
    providers: providers.filter(isCloudProvider).map((p) => ({
      id: p.id,
      hasCredentials: p.hasCredentials === true,
      configured: p.configured,
      ...(p.baseStatus ? { baseStatus: p.baseStatus } : {}),
      state: providerState(p),
    })),
  };
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** The text form (`prepare --status`, `doctor`) of the same inventory. */
export function renderControlBoxInventory(inv: ControlBoxInventory | null): string[] {
  if (!inv) return [];
  if (!inv.reachable) return ['', `control box: unreachable — ${inv.error ?? UNREACHABLE}`];
  if (inv.providers.length === 0) return [];
  const out = ['', 'control box (where cloud boxes are built):'];
  for (const p of inv.providers) out.push(`  ${pad(p.id, 16)} ${p.state}`);
  return out;
}
