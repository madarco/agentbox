/**
 * Merge the control box's registrations with the PC's local boxes for `list`.
 *
 * Pure (no I/O) so the merge rules — which are the whole point — are unit
 * testable: local docker boxes untouched, adopted cloud boxes tagged, un-adopted
 * hub boxes synthesized as rows, and local cloud records the control box has
 * never heard of surfaced as orphans.
 */
import type { ListedBox } from '@agentbox/sandbox-docker';
import type { BoxRegistration } from '@agentbox/relay';

/** Where a row's truth comes from, for the SOURCE column + `--json`. */
export type BoxSource =
  /** A local box: docker, or a cloud box with no control box configured. */
  | 'local'
  /** Registered on the control box (whether or not it is also local here). */
  | 'hub'
  /** A local cloud record the control box doesn't know — likely destroyed there. */
  | 'orphan';

export interface MergedBox extends ListedBox {
  source: BoxSource;
  /** True when the box exists on the control box but not in local state. */
  needsAdopt?: boolean;
  /**
   * The box repo's origin URL, from its registration. An un-adopted hub box has
   * no `projectRoot` (nothing has matched it to a local clone yet), so this is
   * what project-scoped `list` filters on.
   */
  originUrl?: string;
}

export interface MergeHubBoxesOptions {
  /**
   * True when `registrations` came from a cache (or an empty fallback) because
   * the control box didn't answer. A stale listing is NOT authority for absence:
   * a box missing from it may be perfectly alive, we just couldn't ask. Cached
   * rows still render; nothing is tagged an orphan.
   */
  stale?: boolean;
}

/**
 * Build the row set for `list`.
 *
 * `local` is everything in `state.json` (already probed by `listBoxes`);
 * `registrations` is the control box's registry, or null when no control box is
 * configured — in which case every local box is simply `local` and nothing is
 * ever tagged an orphan (we have no authority to call it one).
 */
export function mergeHubBoxes(
  local: ListedBox[],
  registrations: BoxRegistration[] | null,
  opts: MergeHubBoxesOptions = {},
): MergedBox[] {
  if (registrations === null) return local.map((b) => ({ ...b, source: 'local' as const }));

  const bySandboxId = new Map<string, BoxRegistration>();
  const byBoxId = new Map<string, BoxRegistration>();
  for (const reg of registrations) {
    if (reg.sandboxId) bySandboxId.set(reg.sandboxId, reg);
    byBoxId.set(reg.boxId, reg);
  }

  const claimed = new Set<BoxRegistration>();
  const rows: MergedBox[] = local.map((b) => {
    // Docker boxes live on the laptop's loopback relay and never register on
    // the control box — their absence there means nothing.
    if ((b.provider ?? 'docker') === 'docker') return { ...b, source: 'local' as const };
    const reg =
      (b.cloud?.sandboxId ? bySandboxId.get(b.cloud.sandboxId) : undefined) ?? byBoxId.get(b.id);
    if (!reg) {
      // Only a listing we actually got from the control box proves absence. On a
      // stale/failed listing the box's hub state is simply unknown — calling it
      // an orphan would slander every cloud box the moment you go offline.
      return { ...b, source: opts.stale === true ? ('local' as const) : ('orphan' as const) };
    }
    claimed.add(reg);
    // The local record wins for rendering: it carries endpoints, live shell
    // sessions and agent activity that a registration doesn't have.
    return { ...b, source: 'hub' as const };
  });

  for (const reg of registrations) {
    if (claimed.has(reg)) continue;
    // Docker boxes registered on a control box's own loopback relay (the hub
    // running boxes on its own engine) aren't reachable from this PC.
    if (reg.kind === 'docker') continue;
    rows.push(synthesizeRow(reg));
  }
  return rows;
}

/**
 * A row for a box that exists only on the control box. Only the registration's
 * fields are known — no endpoint probe, no live sessions — so the row is
 * deliberately sparse rather than guessing. Adoption (automatic on first
 * by-name use) turns it into a real local record.
 */
function synthesizeRow(reg: BoxRegistration): MergedBox {
  const sandboxId = reg.sandboxId ?? reg.boxId;
  return {
    id: reg.boxId,
    name: reg.name,
    provider: reg.backend ?? 'docker',
    container: `cloud:${sandboxId}`,
    image: reg.image ?? '',
    workspacePath: reg.worktrees?.[0]?.containerPath ?? '/workspace',
    relayToken: '',
    createdAt: reg.createdAt ?? reg.registeredAt,
    cloud: {
      backend: reg.backend ?? '',
      sandboxId,
      image: reg.image,
      webPort: reg.webPort,
      publicHost: reg.publicHost,
      workspaceBranch: reg.worktrees?.[0]?.branch,
      lastState: 'running',
      topology: 'control-plane',
    },
    // The control box holds no live state for a box it isn't polling, and we
    // deliberately don't probe: `list` must not fan out SDK calls. `--live`
    // (post-adoption) is the way to get an authoritative state.
    state: 'running',
    endpoints: { domain: '', domainIsOrb: false, endpoints: [] },
    shellSessions: [],
    codexSession: null,
    opencodeSession: null,
    source: 'hub',
    needsAdopt: true,
    originUrl: reg.originUrl,
  };
}
