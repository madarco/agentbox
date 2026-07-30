/**
 * The docker-side implementation of the hub's Portless (`agentbox.localhost`)
 * friendly-URL integration. The hub lifecycle itself lives in
 * `@agentbox/sandbox-core` and can't reach Portless (a docker-adjacent host
 * tool) directly, so it calls the `hub-hooks.ts` seam; the CLI installs
 * {@link dockerHubPortlessHooks} into that seam at startup. On a docker-free
 * host the seam is empty and the hub just advertises its loopback URL.
 *
 * Every function here is best-effort and never throws — a Portless failure
 * degrades to the loopback URL, exactly like the box path.
 */
import { mkdir, unlink, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HubPortlessHooks } from '@agentbox/sandbox-core';
import { detectPortless, portlessAlias, portlessGetUrl, portlessUnalias } from './portless.js';
import { detectEngine } from './sync/host-export.js';

const STATE_DIR = join(homedir(), '.agentbox');

/**
 * Portless alias for the hub itself. Unlike a box (a container that OrbStack can
 * reach at `<container>.orb.local`), the hub is a host loopback process, so
 * Portless is the only way to give it a friendly host URL. Fixed name → the URL
 * is always `https://agentbox.localhost` (kept static so the Next server-actions
 * origin allowlist can hard-code it). The resolved URL is cached to
 * `HUB_PORTLESS_FILE` so `current()` (read-only) knows the alias is actually
 * live — `portlessGetUrl` alone returns the deterministic fallback either way.
 */
const HUB_PORTLESS_ALIAS = 'agentbox';
const HUB_PORTLESS_FILE = join(STATE_DIR, 'hub', 'portless-url');

/** The Portless URL cached by a prior `sync`, or null when unregistered. */
async function readHubPortlessUrl(): Promise<string | null> {
  try {
    const u = (await readFile(HUB_PORTLESS_FILE, 'utf8')).trim();
    return u.length > 0 ? u : null;
  } catch {
    return null;
  }
}

/**
 * The hub's Portless URL *right now*, or null when it wouldn't resolve.
 *
 * Deliberately not just the cached file. The cache is written once, at hub
 * start, but both of its inputs can change underneath it: the proxy can die
 * (URL resolves to nothing) and it can come back in a different mode (the
 * no-root `:1355` no-TLS proxy vs the root `:443` HTTPS one), which changes the
 * URL's scheme *and* port. Callers — `agentbox hub status`, the tray app — get a
 * URL they can actually open, or none at all.
 */
async function currentHubPortlessUrl(): Promise<string | null> {
  const cached = await readHubPortlessUrl();
  if (cached === null) return null;
  const portless = await detectPortless();
  if (!portless.proxyRunning) return null;
  const url = await portlessGetUrl(HUB_PORTLESS_ALIAS);
  // Keep the cache honest for the next reader (and for anything that reads the
  // file directly) when the proxy came back in a different mode.
  if (url !== cached) await writeFile(HUB_PORTLESS_FILE, url, 'utf8').catch(() => {});
  return url;
}

/**
 * Register (or tear down) the hub's `agentbox.localhost` Portless alias and
 * return its resolved URL. Best-effort and never throws — a Portless failure
 * just leaves the hub on its loopback URL, exactly like the box path.
 *
 * Registers whenever Portless is installed and the engine isn't OrbStack, unless
 * `enabled === false` (explicit opt-out). `undefined` (never prompted) still
 * registers — the hub URL is a pure host-side convenience.
 *
 * Registering the route and *advertising* the URL are two different things. The
 * route is written whenever Portless is installed, proxy or no proxy: it costs
 * nothing and makes the URL work the moment a proxy comes up. The URL is only
 * returned when a proxy is actually live — otherwise `portless get` answers
 * from the persisted registry and the hub would print an address (`agentbox
 * .localhost:1355`) that nothing is listening on, which is precisely what a
 * reboot leaves behind.
 */
async function syncHubPortless(
  enabled: boolean | undefined,
  port: number,
): Promise<string | undefined> {
  const teardown = async (): Promise<undefined> => {
    await portlessUnalias(HUB_PORTLESS_ALIAS).catch(() => {});
    await unlink(HUB_PORTLESS_FILE).catch(() => {});
    return undefined;
  };
  try {
    if (enabled === false) return await teardown();
    // The hub is a host process, so OrbStack's container-only .orb.local can't
    // reach it — and OrbStack users typically run no Portless proxy. Skip.
    if ((await detectEngine()) === 'orbstack') return await teardown();
    const portless = await detectPortless();
    if (!portless.installed) return await teardown();
    await portlessAlias(HUB_PORTLESS_ALIAS, port);
    const url = await portlessGetUrl(HUB_PORTLESS_ALIAS);
    // The file records that the hub *wants* a Portless URL (it is how a later
    // `hub status` knows the alias is ours rather than opted out); whether that
    // URL is usable is re-decided on every read against a live proxy.
    await mkdir(dirname(HUB_PORTLESS_FILE), { recursive: true });
    await writeFile(HUB_PORTLESS_FILE, url, 'utf8');
    return portless.proxyRunning ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort teardown of the hub's Portless alias + its cached URL file. */
async function unregisterHubPortless(): Promise<void> {
  await portlessUnalias(HUB_PORTLESS_ALIAS).catch(() => {});
  await unlink(HUB_PORTLESS_FILE).catch(() => {});
}

/** The hooks the CLI installs into `@agentbox/sandbox-core`'s hub seam. */
export const dockerHubPortlessHooks: HubPortlessHooks = {
  sync: syncHubPortless,
  current: currentHubPortlessUrl,
  teardown: unregisterHubPortless,
};
