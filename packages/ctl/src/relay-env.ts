import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Default location of the per-box relay URL + token file. Under `/run`
 * (tmpfs): rewritten on every daemon start and never captured in a
 * checkpoint/snapshot. `0600`, owned by the daemon user.
 */
const DEFAULT_RELAY_ENV_FILE = '/run/agentbox/relay.env';

/**
 * Resolve the relay-env file path at call time (not import time) so tests can
 * point `AGENTBOX_RELAY_ENV_FILE` at a temp file per-case.
 *
 * The file backs in-box `agentbox-ctl` invocations that don't inherit the ctl
 * daemon's process env — the interactive agent (launched via a tmux login
 * shell) and the host-driven `agentbox git push <box>`. On docker boxes the
 * relay env is global (`docker run -e`), so this file is unused; on cloud boxes
 * there's no global env, so the daemon writes it (`writeRelayEnvFile`) and the
 * readers below fall back to it.
 */
export function relayEnvFilePath(): string {
  return process.env.AGENTBOX_RELAY_ENV_FILE ?? DEFAULT_RELAY_ENV_FILE;
}

/**
 * Resolve the relay URL + token: prefer the process env, fall back to the
 * `0600` file the cloud daemon writes. A missing/unreadable file leaves the
 * corresponding value undefined (env-only behavior, as before).
 */
export function resolveRelayEnv(env: NodeJS.ProcessEnv = process.env): {
  url?: string;
  token?: string;
} {
  let url = env.AGENTBOX_RELAY_URL;
  let token = env.AGENTBOX_RELAY_TOKEN;
  if (url && token) return { url, token };

  try {
    const text = readFileSync(relayEnvFilePath(), 'utf8');
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === 'AGENTBOX_RELAY_URL') url ??= value;
      else if (key === 'AGENTBOX_RELAY_TOKEN') token ??= value;
    }
  } catch {
    // file absent/unreadable → env-only
  }
  return { url, token };
}

/**
 * Persist the relay URL + token to the relay-env file (`0600`). Called by the
 * cloud ctl daemon once it has validated its own per-box token. Deliberately
 * NOT the bridge token — that authenticates the host poller to `/bridge/*` and
 * is consumed only by the daemon's process env. Throws are the caller's to
 * swallow (a failure only costs the file fallback, not the relay).
 */
export function writeRelayEnvFile(url: string, token: string): void {
  const path = relayEnvFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const body = `AGENTBOX_RELAY_URL=${url}\nAGENTBOX_RELAY_TOKEN=${token}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  // mode on writeFileSync only applies when creating the file; enforce it in
  // case the file already existed with looser perms.
  chmodSync(path, 0o600);
}
