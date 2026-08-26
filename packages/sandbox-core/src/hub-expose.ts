/**
 * Pure assembly of the exposed hub's spawn env — the flip `agentbox hub expose`
 * applies to the ONE local hub process to make it the control box (deployed
 * `hetzner` profile) instead of the plain localhost hub.
 *
 * Lives in sandbox-core (not the CLI) because BOTH sides need it: the CLI's
 * expose flow writes the record, and `ensureHub()` in sandbox-docker reads the
 * record back on every `hub start` / restart / autostart to bring the hub up in
 * the same mode. Keeping it pure (record + env-file map in, env out) makes the
 * flip unit-testable and keeps a single source of truth for the env.
 */
import type { ControlPlaneDeployRecord } from './ssh-config.js';

/** The profile an exposed hub runs in (password auth + SQLite store + worker). */
export const EXPOSED_HUB_PROFILE = 'hetzner';

/**
 * Parse an `.env`-style file body into a map. Same shape as the CLI's env-file
 * reader; duplicated here (one tiny regex) so sandbox-core needs no CLI import.
 */
export function parseEnvFileBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * The env overrides that turn the localhost hub into the exposed control box.
 * Applied over the base spawn env, so `AGENTBOX_HUB_HOST` (loopback by default)
 * becomes the LAN/loopback bind, the profile flips to `hetzner` (password +
 * SQLite + worker), and the box-facing public URL + secrets are carried in.
 *
 * `env` is the parsed `control-plane.env` (admin token, API key, GH token, and
 * — after `hub expose` prompts — the auth block). Missing keys are simply
 * omitted; the hub fails closed on a missing secret rather than this function.
 */
export function buildExposedHubEnv(
  record: ControlPlaneDeployRecord,
  env: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {
    AGENTBOX_HUB_HOST: record.bind || '0.0.0.0',
    AGENTBOX_HUB_PROFILE: EXPOSED_HUB_PROFILE,
    AGENTBOX_HUB_AUTH: 'on',
    AGENTBOX_HUB_WORKER: 'on',
  };
  if (record.port) out.AGENTBOX_HUB_PORT = String(record.port);
  if (record.publicUrl) out.AGENTBOX_HUB_PUBLIC_URL = record.publicUrl;
  if (record.adminCidr) out.AGENTBOX_HUB_ADMIN_CIDR = record.adminCidr;
  // Secrets from control-plane.env — the /admin wire token, the headless
  // /api/v1 key, the login secret + admin creds, and the hub's own git token.
  for (const k of [
    'AGENTBOX_RELAY_ADMIN_TOKEN',
    'AGENTBOX_HUB_API_KEY',
    'BETTER_AUTH_SECRET',
    'AGENTBOX_HUB_ADMIN_EMAIL',
    'AGENTBOX_HUB_ADMIN_PASSWORD',
    'GH_TOKEN',
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
  ]) {
    if (env[k]) out[k] = env[k]!;
  }
  return out;
}
