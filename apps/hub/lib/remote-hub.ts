/**
 * Read the CONTROL BOX's provider state from the PC's own hub.
 *
 * With `cloud.viaHub` on (the default), a cloud box is created on the control
 * box and built from ITS baked bases — this machine's cloud bakes are never
 * used. The local UI nonetheless reported its own, so `agentbox.localhost` could
 * insist "hetzner — needs bake" while `agentbox hetzner` created boxes fine.
 * Mirroring the control box makes the page describe the machine that will
 * actually do the work.
 *
 * Read-only on purpose: actions on a remote provider belong to the remote hub's
 * own UI, which the settings page links out to. The hub's public `/api/v1` is
 * the whole contract here — no new endpoint, no custody access.
 */
import { resolveControlBox, type ControlBoxTarget } from '@agentbox/relay';
import type { ProviderOption } from './boxes/types';

/**
 * Bound on the round-trip. `?freshness=1` makes the remote hub hash its build
 * context, so it is not instant — but this sits on a page render, and an
 * unreachable control box must cost a fixed, small amount of time.
 */
const FETCH_MS = 2500;

/**
 * How long a fetched answer is reused. The remote's bake state changes on the
 * scale of minutes (a bake takes longer than this), so a short memo keeps the
 * frequently-polled settings page off the network without going stale in
 * practice. Mirrors the local `freshnessCache` discipline in hub-backend.
 */
const CACHE_MS = 30_000;

export type RemoteHubTarget = ControlBoxTarget;

/**
 * The configured control box + its API key, for the PROVIDER MIRROR, or null
 * when there is none.
 *
 * `cloud.viaHub=false` opts out of hub-routed creates, so cloud boxes are built
 * HERE again and this machine's own bakes are the answer; mirroring then would
 * describe a machine that does no work for this user. That clause is this
 * reader's alone — the workspace store is on the control box however the boxes
 * get built, which is why the timeline sink resolves it without one.
 */
export function resolveRemoteHub(): Promise<RemoteHubTarget | null> {
  return resolveControlBox({ requireViaHub: true });
}

let cache: { at: number; providers: ProviderOption[] | null } | null = null;

/**
 * The control box's providers, `null` when it is configured but unreachable
 * (which the caller must render as "unknown" — never as this machine's state
 * under a control-box label), and `undefined` when none is configured.
 *
 * Never throws.
 */
export async function fetchRemoteProviders(): Promise<ProviderOption[] | null | undefined> {
  const target = await resolveRemoteHub();
  if (!target) return undefined;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.providers;
  let providers: ProviderOption[] | null = null;
  try {
    const res = await fetch(`${target.url}/api/v1/providers?freshness=1`, {
      headers: { Authorization: `Bearer ${target.apiKey}` },
      signal: AbortSignal.timeout(FETCH_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { providers?: ProviderOption[] };
      if (Array.isArray(body.providers)) providers = body.providers;
    }
  } catch {
    providers = null;
  }
  cache = { at: Date.now(), providers };
  return providers;
}

/** Drop the memo so a just-triggered change is reflected on the next read. */
export function invalidateRemoteProviders(): void {
  cache = null;
}
