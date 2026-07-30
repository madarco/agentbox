/**
 * Which relay does a given box actually talk to?
 *
 * A docker box (and a cloud box created with no control box configured) uses the
 * laptop's own loopback relay. A box created against a control box registers
 * THERE instead — its host-action approvals, status and registry row all live on
 * the VPS. Anything on this host that reaches for "the relay" has to ask which
 * one, or it silently talks to the wrong mailbox: that is why the attach footer
 * and `agentbox agent approvals` used to show nothing for a hub box.
 */
import type { BoxRecord } from '@agentbox/core';
import { DEFAULT_RELAY_PORT } from '@agentbox/relay';
import { HubApiClient } from './hub-api-client.js';

/** The laptop's own relay daemon. */
export const LOCAL_RELAY_URL = `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`;

/**
 * - a target      — the control box this box registered with, plus its bearer.
 * - `none`        — no control box in play; the local relay is the whole story.
 * - `no-token`    — a control box we can name but can't authenticate to.
 */
export type BoxPlane = { url: string; adminToken: string } | 'none' | 'no-token';

/**
 * The bits of a box that decide which relay it uses. Deliberately narrower than
 * `BoxRecord`: a box that exists only on the control box has no local record at
 * all, and the dashboard must still resolve its plane from the merged listing
 * row (`DashboardBox`) to show its approval marker.
 */
export type PlaneAddressable = Pick<BoxRecord, 'provider' | 'cloud'>;

/**
 * Resolve the control box holding this box's state, and the bearer for it.
 *
 * The URL comes from the box's own record first: `cloud.controlPlaneUrl` is the
 * plane it actually registered with, which survives a later config change (or
 * removal) on this host — exactly the case where box state would otherwise
 * become unreachable forever. Only then does it fall back to
 * `relay.controlPlaneUrl`.
 *
 * The token isn't persisted per box, so it always comes from the environment /
 * the setup-written env file. Distinguishing `no-token` from `none` matters: no
 * plane at all means there is genuinely nothing to ask, while a known plane we
 * can't authenticate to is an answer we never got.
 *
 * Docker boxes short-circuit to `none` — they register on the laptop loopback
 * relay and are never on a plane, the same rule `mergeHubBoxes` applies.
 *
 * Imports lazily: this runs on paths that also serve hosts with no control box
 * at all (every attach, every destroy), which shouldn't pay to load config +
 * relay code.
 */
export async function resolveBoxPlane(box: PlaneAddressable): Promise<BoxPlane> {
  if ((box.provider ?? 'docker') === 'docker') return 'none';
  const { loadEffectiveConfig } = await import('@agentbox/config');
  const { loadControlPlaneEnv } = await import('./env-file.js');
  const configured = await loadEffectiveConfig(process.cwd())
    .then((c) => c.effective.relay.controlPlaneUrl)
    .catch(() => undefined);
  const url = (box.cloud?.controlPlaneUrl ?? configured ?? '').replace(/\/+$/, '');
  if (!url) return 'none';
  loadControlPlaneEnv();
  const adminToken = process.env['AGENTBOX_RELAY_ADMIN_TOKEN'] ?? '';
  return adminToken ? { url, adminToken } : 'no-token';
}

/**
 * The hub that owns a box's approvals, resolved to its `/api/v1` target.
 *
 * Mirrors {@link resolveBoxPlane} but for the *client* surface: the URL comes
 * from `cloud.controlPlaneUrl` first (survives a config change on this host),
 * else `relay.controlPlaneUrl`, and the Bearer is the hub API key
 * (`AGENTBOX_HUB_API_KEY`) — not the admin token. A docker box short-circuits to
 * `none` (its approvals live on the local hub).
 */
type BoxHubTarget = { url: string; apiKey: string } | 'none' | 'no-token';

async function resolveBoxHubTarget(box: PlaneAddressable): Promise<BoxHubTarget> {
  if ((box.provider ?? 'docker') === 'docker') return 'none';
  const { loadEffectiveConfig } = await import('@agentbox/config');
  const { loadControlPlaneEnv } = await import('./env-file.js');
  const configured = await loadEffectiveConfig(process.cwd())
    .then((c) => c.effective.relay.controlPlaneUrl)
    .catch(() => undefined);
  const url = (box.cloud?.controlPlaneUrl ?? configured ?? '').replace(/\/+$/, '');
  if (!url) return 'none';
  loadControlPlaneEnv();
  const apiKey = process.env['AGENTBOX_HUB_API_KEY'] ?? '';
  return apiKey ? { url, apiKey } : 'no-token';
}

/** Where to read/answer this box's host-action approvals, over the hub `/api/v1`. */
export interface BoxPromptSource {
  /** For list/answer (`agent approvals`/`approve`). */
  client: HubApiClient;
  /** For the footer's low-level SSE prompt stream. */
  baseUrl: string;
  apiKey?: string;
  /** True when `baseUrl` is a control box rather than this laptop's hub. */
  remote: boolean;
  /**
   * Set when the box lives on a control box we couldn't authenticate to. The
   * source falls back to the local hub (which will simply have nothing), so
   * callers can degrade quietly but still explain the silence.
   */
  unauthenticatedPlane?: string;
}

/**
 * Resolve the prompt mailbox for a box as a hub `/api/v1` client + SSE target.
 *
 * A docker box (or a cloud box with no control box) answers on the **local hub**,
 * which is auto-started here so `/api/v1` is actually available (a bare relay
 * can't serve it). A cloud box on a plane answers on that control box, keyed by
 * the hub API key. A named-but-unauthenticated plane degrades to the local hub
 * and sets `unauthenticatedPlane` so callers can explain the silence.
 *
 * Returns null only when even the local hub can't be resolved/started (`quiet`
 * suppresses the autostart + error print — used by the dashboard TUI, which owns
 * the screen and must not spawn a spinner mid-render).
 */
export async function resolveBoxPromptSource(
  box: PlaneAddressable,
  opts: { quiet?: boolean } = {},
): Promise<BoxPromptSource | null> {
  const target = await resolveBoxHubTarget(box).catch(() => 'none' as const);
  if (target === 'none' || target === 'no-token') {
    const { resolveHubApiTarget } = await import('../commands/control-plane.js');
    const local = await resolveHubApiTarget(undefined, { preferLocal: true, quiet: opts.quiet });
    if (!local) return null;
    return {
      client: new HubApiClient(local),
      baseUrl: local.url,
      apiKey: local.apiKey,
      remote: false,
      ...(target === 'no-token'
        ? { unauthenticatedPlane: box.cloud?.controlPlaneUrl ?? '(configured control box)' }
        : {}),
    };
  }
  return {
    client: new HubApiClient(target),
    baseUrl: target.url,
    apiKey: target.apiKey,
    remote: true,
  };
}

/** Warn at most once per process — an attach may resolve this several times. */
let warnedNoToken = false;

/**
 * The `runWrappedAttach` options that point the attach footer's prompt stream at
 * the right hub. Spread into the call: `...(await attachRelayOptions(box))`.
 *
 * A box on a plane we can't authenticate to degrades to the local hub — the
 * footer then behaves exactly as it did before this existed (silent) — but says
 * so once, since a silent footer on a blocked box is otherwise unexplainable. A
 * hub that can't be resolved at all yields an empty base URL, which
 * `subscribePrompts` treats as a no-op stream — attach never breaks over it.
 */
export async function attachRelayOptions(
  box: PlaneAddressable,
): Promise<{ hubBaseUrl: string; hubApiKey?: string }> {
  const source = await resolveBoxPromptSource(box);
  if (!source) return { hubBaseUrl: '' };
  if (source.unauthenticatedPlane !== undefined && !warnedNoToken) {
    warnedNoToken = true;
    process.stderr.write(
      `note: this box's approvals live on ${source.unauthenticatedPlane}, but no hub API key is available here,\n` +
        "      so the attach footer can't show them. Set AGENTBOX_HUB_API_KEY, or answer them with\n" +
        '      `agentbox hub approvals list` / `agentbox hub approvals answer`.\n',
    );
  }
  return { hubBaseUrl: source.baseUrl, hubApiKey: source.apiKey };
}
