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
 * row (`MergedBox`) to show its approval marker.
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

/** Where to read/answer this box's host-action approvals. */
export interface BoxPromptSource {
  baseUrl: string;
  /** Set only for a remote control box; the local relay's gate passes on loopback. */
  authToken?: string;
  /** True when `baseUrl` is a control box rather than this laptop's relay. */
  remote: boolean;
  /**
   * Set when the box lives on a control box we couldn't authenticate to. The
   * source falls back to the local relay (which will simply have nothing), so
   * callers can degrade quietly but still explain the silence.
   */
  unauthenticatedPlane?: string;
}

/**
 * Resolve the prompt mailbox for a box. Never throws — a resolution failure
 * degrades to the local relay, which is exactly today's behavior.
 */
export async function resolveBoxPromptSource(box: PlaneAddressable): Promise<BoxPromptSource> {
  const plane = await resolveBoxPlane(box).catch(() => 'none' as const);
  if (plane === 'none') return { baseUrl: LOCAL_RELAY_URL, remote: false };
  if (plane === 'no-token') {
    const named = box.cloud?.controlPlaneUrl ?? '(configured control box)';
    return { baseUrl: LOCAL_RELAY_URL, remote: false, unauthenticatedPlane: named };
  }
  return { baseUrl: plane.url, authToken: plane.adminToken, remote: true };
}

/** Warn at most once per process — an attach may resolve this several times. */
let warnedNoToken = false;

/**
 * The `runWrappedAttach` options that point the attach footer's prompt stream at
 * the right relay. Spread into the call: `...(await attachRelayOptions(box))`.
 *
 * A box on a plane we can't authenticate to degrades to the local relay — the
 * footer then behaves exactly as it did before this existed (silent) — but says
 * so once, since a silent footer on a blocked box is otherwise unexplainable.
 */
export async function attachRelayOptions(
  box: PlaneAddressable,
): Promise<{ relayBaseUrl: string; relayAuthToken?: string }> {
  const source = await resolveBoxPromptSource(box);
  if (source.unauthenticatedPlane !== undefined && !warnedNoToken) {
    warnedNoToken = true;
    process.stderr.write(
      `note: this box's approvals live on ${source.unauthenticatedPlane}, but no admin token is available here,\n` +
        '      so the attach footer can\'t show them. Set AGENTBOX_RELAY_ADMIN_TOKEN, or answer them with\n' +
        '      `agentbox hub approvals list` / `agentbox hub approvals answer`.\n',
    );
  }
  return { relayBaseUrl: source.baseUrl, relayAuthToken: source.authToken };
}
