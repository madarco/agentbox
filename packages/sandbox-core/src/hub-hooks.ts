/**
 * One-slot hooks the hub lifecycle (`hub-lifecycle.ts`) uses to reach the two
 * docker-side conveniences it can't depend on directly — the Portless friendly
 * URL and the docker build context. Same pattern as `credential-publish.ts`:
 * the docker package (`@agentbox/sandbox-docker`) owns the implementation and
 * the CLI installs it at startup, so a docker-free host that starts / probes the
 * hub imports neither Portless nor docker image machinery.
 *
 * Both are best-effort niceties, so an unset hook degrades cleanly: no hook →
 * the hub advertises its plain loopback URL and sets no `AGENTBOX_DOCKER_CONTEXT`.
 */

/**
 * The hub's Portless (`https://agentbox.localhost`) integration. Each method is
 * best-effort and must never throw — a Portless failure leaves the hub on its
 * loopback URL.
 */
export interface HubPortlessHooks {
  /**
   * Register (or, with `enabled === false`, tear down) the hub's Portless alias
   * for `port` and return its resolved URL, or `undefined` when no proxy is live.
   */
  sync(enabled: boolean | undefined, port: number): Promise<string | undefined>;
  /** The hub's Portless URL right now, re-checked against a live proxy, or null. */
  current(): Promise<string | null>;
  /** Tear down the alias + its cached URL (on `hub stop`). */
  teardown(): Promise<void>;
}

let activePortless: HubPortlessHooks | undefined;

/** Install (or clear) the Portless hooks. The CLI calls this once at startup. */
export function setHubPortlessHooks(hooks: HubPortlessHooks | undefined): void {
  activePortless = hooks;
}

/** Sync the hub's Portless alias, or `undefined` when no hooks are installed. */
export async function hubPortlessSync(
  enabled: boolean | undefined,
  port: number,
): Promise<string | undefined> {
  if (!activePortless) return undefined;
  try {
    return await activePortless.sync(enabled, port);
  } catch {
    return undefined;
  }
}

/** The hub's current Portless URL, or `null` when no hooks are installed. */
export async function hubPortlessCurrent(): Promise<string | null> {
  if (!activePortless) return null;
  try {
    return await activePortless.current();
  } catch {
    return null;
  }
}

/** Tear down the hub's Portless alias, if hooks are installed. */
export async function hubPortlessTeardown(): Promise<void> {
  if (!activePortless) return;
  try {
    await activePortless.teardown();
  } catch {
    /* best-effort */
  }
}

let dockerContext: string | undefined;

/**
 * Set the docker build-context dir the hub child should see as
 * `AGENTBOX_DOCKER_CONTEXT` (the CLI installs its resolved `BUILD_CONTEXT_DIR`).
 * Unset on a docker-free host → the key is omitted, which is correct there.
 */
export function setHubDockerContext(dir: string | undefined): void {
  dockerContext = dir;
}

/** The installed docker build-context dir, or `undefined`. */
export function hubDockerContext(): string | undefined {
  return dockerContext;
}
