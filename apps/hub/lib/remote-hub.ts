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
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEffectiveConfig } from '@agentbox/config';
import { parseEnvFileBody } from '@agentbox/sandbox-core';
import type { ProviderOption } from './boxes/types';

/** Where `agentbox hub setup` records the control box's `/api/v1` key. */
const CONTROL_PLANE_ENV = path.join(os.homedir(), '.agentbox', 'control-plane', 'control-plane.env');

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

export interface RemoteHubTarget {
  url: string;
  apiKey: string;
}

/**
 * True when this process IS a control box (deployed, or a hub this machine
 * exposed). Both run the resident worker, and only they do. A control box has no
 * control box of its own, so mirroring there would mean querying itself.
 */
function isControlBox(): boolean {
  return process.env.AGENTBOX_HUB_WORKER === 'on';
}

/** The configured control box + its API key, or null when there is none. */
export async function resolveRemoteHub(): Promise<RemoteHubTarget | null> {
  if (isControlBox()) return null;
  try {
    const cfg = await loadEffectiveConfig(os.homedir());
    const url = (cfg.effective.relay.controlPlaneUrl ?? '').replace(/\/+$/, '');
    if (!url) return null;
    // The key never reaches this process's env (the hub is spawned before, or
    // without, `hub setup`), so read the file the CLI writes it to.
    const env = parseEnvFileBody(await readFile(CONTROL_PLANE_ENV, 'utf8').catch(() => ''));
    const apiKey = process.env.AGENTBOX_HUB_API_KEY || (env.AGENTBOX_HUB_API_KEY ?? '');
    return apiKey ? { url, apiKey } : null;
  } catch {
    return null;
  }
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
