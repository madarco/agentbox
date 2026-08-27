import { loadEffectiveConfig } from '@agentbox/config';
import { DEFAULT_BOX_RELAY_PORT } from '@agentbox/relay';
import { isValidRelayPort, setRelayPort } from '@agentbox/sandbox-core';

/**
 * Pin the host daemon's port from `relay.port`. Called once from the CLI
 * entrypoint before commander parses argv, alongside `applyEngineOverride…`.
 *
 * The port is machine-wide (relay and hub share it, and their pid/log files at
 * `~/.agentbox/relay.*` are single) — so this is a "set it `--global`" key even
 * though the usual layer precedence applies.
 *
 * Returns a warning to print, or null. Errors are swallowed: a broken config
 * must not crash `--help`, and the matching `agentbox config` subcommand
 * surfaces a clean error when the user next touches it.
 */
export async function applyRelayPortAtStartup(): Promise<string | null> {
  try {
    const loaded = await loadEffectiveConfig(process.cwd());
    const port = loaded.effective.relay.port;
    if (!isValidRelayPort(port)) {
      return `ignoring relay.port=${String(port)}: not a valid TCP port (1-65535)`;
    }
    if (port === DEFAULT_BOX_RELAY_PORT) {
      // Every box binds this port internally for its own in-box relay /
      // forwarder. A host relay here would collide with a nested agentbox run,
      // which is the exact scenario the two-port split exists to allow.
      return (
        `ignoring relay.port=${String(port)}: reserved for the in-box relay ` +
        `(AGENTBOX_BOX_RELAY_PORT). Pick another port.`
      );
    }
    setRelayPort(port);
    return null;
  } catch {
    return null;
  }
}
