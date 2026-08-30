/**
 * The dashboard's box list: this machine's local boxes, merged with the hub's
 * authoritative listing so the sidebar also shows cloud boxes that live only on
 * a control box (not yet adopted here).
 *
 * Why a merge at all, when `agentbox ls` reads `/api/v1/boxes` alone: the
 * dashboard is the IO-plane TUI. It drives boxes from THIS machine, so it needs
 * the rich local fields a live `listBoxes()` probe carries — `claudeQuestion`
 * (the AskUserQuestion payload painted into the alert band), live shell sessions,
 * resolved endpoints — that the hub's `HubApiBox` view does not. So the local
 * boxes stay authoritative for rendering + driving, and the hub listing only
 * contributes the rows this machine has never adopted.
 *
 * Sourced from the SAME `/api/v1/boxes` wire `ls` uses (`fetchBoxListing`) — NOT
 * the retired `/admin/store` registration wire. In both modes the base URL + key
 * differ, nothing else. Degrade-first: an unreachable hub yields a stale/empty
 * listing (never throws), in which case this is exactly the local boxes and
 * nothing is ever tagged an orphan (a stale listing is no authority for absence).
 */
import { listBoxes, type ListedBox } from '@agentbox/sandbox-docker';
import type { BoxRuntimeState, BoxState } from '@agentbox/core';

import { fetchBoxListing } from '../control-plane/hub-list.js';
import { hubBoxAgentStatus } from '../control-plane/hub-api-client.js';
import type { HubApiBox } from '../control-plane/hub-api-client.js';

/** Where a row's truth comes from, for the sidebar. */
export type BoxSource =
  /** A local box: docker, or a cloud box with no control box configured. */
  | 'local'
  /** Also known to the hub (whether or not it is local here). */
  | 'hub'
  /** A local cloud record the hub doesn't know — likely destroyed there. */
  | 'orphan';

export interface DashboardBox extends ListedBox {
  source: BoxSource;
  /** True when the box exists on the hub but not in local state (needs adoption). */
  needsAdopt?: boolean;
  /** The box repo's origin URL, from the hub row — an un-adopted box has no local
   *  `projectRoot`, so this is what project-scoped views can filter on. */
  originUrl?: string;
}

/**
 * Local boxes merged with the hub's listing. Never throws on the hub half — an
 * unreachable hub yields the local boxes plus (when the listing is stale) no
 * orphan tags.
 */
export async function listDashboardBoxes(): Promise<DashboardBox[]> {
  const local = await listBoxes();
  const listing = await fetchBoxListing().catch(() => null);
  return mergeApiBoxes(local, listing?.boxes ?? null, { stale: listing?.stale });
}

/**
 * Build the row set. `local` is everything in `state.json` (already probed);
 * `hubBoxes` is the hub's `/api/v1/boxes` listing, or null when it couldn't be
 * fetched — in which case every local box is simply `local` and nothing is ever
 * tagged an orphan (no authority to call it one).
 *
 * Pure (no I/O) so the merge rules stay testable.
 */
export function mergeApiBoxes(
  local: ListedBox[],
  hubBoxes: HubApiBox[] | null,
  opts: { stale?: boolean } = {},
): DashboardBox[] {
  if (hubBoxes === null) return local.map((b) => ({ ...b, source: 'local' as const }));

  const bySandboxId = new Map<string, HubApiBox>();
  const byId = new Map<string, HubApiBox>();
  for (const hb of hubBoxes) {
    if (hb.sandboxId) bySandboxId.set(hb.sandboxId, hb);
    byId.set(hb.id, hb);
  }

  const claimed = new Set<HubApiBox>();
  const rows: DashboardBox[] = local.map((b) => {
    // Docker boxes live on the laptop's loopback relay; a remote hub's listing
    // never contains them, so their absence there means nothing.
    if ((b.provider ?? 'docker') === 'docker') return { ...b, source: 'local' as const };
    const hb =
      (b.cloud?.sandboxId ? bySandboxId.get(b.cloud.sandboxId) : undefined) ?? byId.get(b.id);
    if (!hb) {
      // Only a listing we actually got proves absence. On a stale/failed listing
      // the box's hub state is simply unknown — calling it an orphan would slander
      // every cloud box the moment the hub goes unreachable.
      return { ...b, source: opts.stale === true ? ('local' as const) : ('orphan' as const) };
    }
    claimed.add(hb);
    // The local record wins for rendering: it carries endpoints, live shell
    // sessions and agent activity the hub row doesn't have.
    return { ...b, source: 'hub' as const };
  });

  for (const hb of hubBoxes) {
    if (claimed.has(hb)) continue;
    // A docker box in the listing is the hub's OWN local container (its engine),
    // not reachable from this PC — same rule the local branch above applies.
    if ((hb.provider ?? 'docker') === 'docker') continue;
    rows.push(synthesizeRow(hb));
  }
  return rows;
}

/**
 * A row for a box that exists only on the hub. Only the hub row's non-secret
 * fields are known — no local endpoint probe, no live sessions — so the row is
 * deliberately sparse. Adoption (automatic on first by-name use) turns it into a
 * real local record.
 */
/**
 * The per-agent fields a `DashboardBox` carries, from a hub row.
 *
 * `agentStatus` is the source; the named fields are its derived projection, kept
 * for the hub payload's own older clients. Built here rather than copied field
 * by field so a hub that sends the map (and a fourth agent with it) is not
 * flattened down to the three names on the way in.
 */
function hubAgentFields(
  hb: HubApiBox,
): Pick<
  DashboardBox,
  | 'agentStatus'
  | 'claudeActivity'
  | 'claudeSessionTitle'
  | 'codexActivity'
  | 'codexSessionTitle'
  | 'opencodeActivity'
  | 'opencodeSessionTitle'
> {
  const agentStatus = hubBoxAgentStatus(hb);
  return {
    agentStatus,
    claudeActivity: agentStatus.claude?.state,
    claudeSessionTitle: agentStatus.claude?.sessionTitle,
    codexActivity: agentStatus.codex?.state,
    codexSessionTitle: agentStatus.codex?.sessionTitle,
    opencodeActivity: agentStatus.opencode?.state,
    opencodeSessionTitle: agentStatus.opencode?.sessionTitle,
  };
}

function synthesizeRow(hb: HubApiBox): DashboardBox {
  const sandboxId = hb.sandboxId ?? hb.id;
  const state: BoxState = hb.state ?? 'running';
  // `cloud.lastState` (BoxRuntimeState) has no 'destroyed'; fold it to 'stopped'.
  const lastState: BoxRuntimeState = state === 'destroyed' ? 'stopped' : state;
  return {
    id: hb.id,
    name: hb.displayName || hb.name || hb.task || hb.id,
    provider: hb.provider,
    container: `cloud:${sandboxId}`,
    image: hb.image ?? '',
    workspacePath: '/workspace',
    relayToken: '',
    createdAt: new Date(hb.createdAt ?? 0).toISOString(),
    ...(hb.projectRoot !== undefined ? { projectRoot: hb.projectRoot } : {}),
    ...(hb.projectIndex !== undefined ? { projectIndex: hb.projectIndex } : {}),
    cloud: {
      backend: hb.provider,
      sandboxId,
      image: hb.image,
      webPort: hb.webPort,
      publicHost: hb.publicHost,
      workspaceBranch: hb.branch,
      lastState,
      // A hub-only row is always a control-plane box (created elsewhere, driven
      // via the control box) — the same literal the old registration synth used.
      topology: 'control-plane',
    },
    state,
    // Agent activity / titles the hub row does carry, so the sidebar paints the
    // right agent + activity for an un-adopted box too.
    ...hubAgentFields(hb),
    endpoints: { domain: '', domainIsOrb: false, endpoints: [] },
    shellSessions: [],
    codexSession: null,
    opencodeSession: null,
    source: 'hub',
    needsAdopt: true,
    ...(hb.originUrl ? { originUrl: hb.originUrl } : {}),
  };
}
