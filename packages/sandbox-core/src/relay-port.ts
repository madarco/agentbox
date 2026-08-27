/**
 * The single resolver for the port the host daemon binds.
 *
 * Relay and hub share it: the hub IS the relay daemon plus a Next UI in one
 * process, so the two are mutually exclusive there (see `hub-lifecycle.ts`).
 * One resolver means one answer for both — and for the probes in
 * `hub-process.ts`, the box-facing `host.docker.internal:<port>` URL, and the
 * `--port` handed to the spawned `agentbox-relay serve`.
 *
 * Resolution order:
 *   1. an explicit {@link setRelayPort} (the CLI seeds this from `relay.port`
 *      at startup, before commander parses argv)
 *   2. `AGENTBOX_RELAY_PORT`
 *   3. {@link FALLBACK_RELAY_PORT}
 *
 * The env mirror is not a second config surface — it is how CHILD processes
 * learn the port. The relay daemon, the hub's `server.ts`, the detached queue
 * worker and the `AGENTBOX_CLI_ENTRY` the relay shells back into for host
 * actions all inherit `process.env`, and none of them should re-read the
 * layered config to agree with their parent. Same idiom as the
 * `AGENTBOX_CLI_VERSION` / `AGENTBOX_CLI_RUNTIME_DIR` stamps in the CLI entry.
 */

/**
 * Mirrors `DEFAULT_RELAY_PORT` in `@agentbox/relay`, which this package cannot
 * import (`@agentbox/relay` depends on `@agentbox/sandbox-core`, so the edge
 * would be a cycle). This is the ONLY duplicate of the number, and everything
 * else in the tree now resolves through {@link relayPort}.
 */
export const FALLBACK_RELAY_PORT = 8787;

/** Env var carrying the resolved port to child processes. */
export const RELAY_PORT_ENV = 'AGENTBOX_RELAY_PORT';

let override: number | null = null;

/** True for a value that can actually be bound. */
export function isValidRelayPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Pin the port for this process and every child it spawns. Called once from the
 * CLI entrypoint with the effective `relay.port`. Invalid values are ignored so
 * a typo in a config file can never leave the daemon unbindable — the caller
 * validates and warns.
 */
export function setRelayPort(port: number): void {
  if (!isValidRelayPort(port)) return;
  override = port;
  process.env[RELAY_PORT_ENV] = String(port);
}

/** The port the relay/hub binds here. Cheap — safe to call per request. */
export function relayPort(): number {
  if (override !== null) return override;
  const fromEnv = Number.parseInt(process.env[RELAY_PORT_ENV] ?? '', 10);
  return isValidRelayPort(fromEnv) ? fromEnv : FALLBACK_RELAY_PORT;
}

/** Test seam: drop the pinned value (and the env mirror). */
export function resetRelayPort(): void {
  override = null;
  delete process.env[RELAY_PORT_ENV];
}
