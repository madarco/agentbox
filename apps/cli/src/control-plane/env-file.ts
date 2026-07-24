/**
 * The control-plane env file (`~/.agentbox/control-plane/control-plane.env`),
 * written by `agentbox hub setup`.
 *
 * It holds the admin bearer the CLI authenticates to the control box with, plus
 * the GitHub App credentials. Several paths need those in `process.env` —
 * custody calls, the worker, and (the easy one to miss) **create**, whose
 * provider registers the box on the plane and pushes its seed material.
 *
 * Kept out of the command modules so low-level code (the provider registry) can
 * load it without importing a command.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONTROL_PLANE_ENV_PATH = join(homedir(), '.agentbox', 'control-plane', 'control-plane.env');

/**
 * Merge the env file into `process.env` for keys that aren't already set, so an
 * explicit env var always wins. No-op when the file is absent.
 *
 * Deliberately NOT short-circuited on "the App creds are already exported": the
 * file carries `AGENTBOX_RELAY_ADMIN_TOKEN` too, and skipping the whole file
 * because of an unrelated key left create unable to register (silently) for
 * anyone who exports `GITHUB_APP_*` for other work. The per-key guard below
 * already makes an explicit env var win, so reading the file is always safe.
 */
export function loadControlPlaneEnv(path: string = CONTROL_PLANE_ENV_PATH): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
}
