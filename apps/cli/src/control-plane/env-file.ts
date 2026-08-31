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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONTROL_PLANE_ENV_PATH = join(
  homedir(),
  '.agentbox',
  'control-plane',
  'control-plane.env',
);

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

/**
 * The env file parsed into a map, WITHOUT touching `process.env`. Used by the
 * `hub expose` flow, which assembles the exposed hub's spawn env from these
 * values regardless of what happens to be exported in the current shell.
 * Returns {} when the file is absent.
 */
export function readControlPlaneEnvMap(
  path: string = CONTROL_PLANE_ENV_PATH,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * Set or remove a single key in `control-plane.env`, in place.
 *
 * An append-only write is wrong for anything that can be turned OFF again:
 * `AGENTBOX_TUNNEL_TOKEN` used to be appended when `--tunnel-token` was passed
 * and never cleared, so after `unexpose --keep-credentials` a re-expose as a
 * *quick* tunnel still found the old token on the next `hub start` and brought
 * up a NAMED tunnel on a hostname the record knows nothing about. Repeated
 * exposes also stacked duplicate lines.
 *
 * `value === null` removes the key. Rewrites the file 0600.
 */
export function setControlPlaneEnvKey(
  key: string,
  value: string | null,
  path: string = CONTROL_PLANE_ENV_PATH,
): void {
  const body = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const kept = body.split('\n').filter((line) => !new RegExp(`^${key}=`).test(line.trim()));
  if (value !== null) kept.push(`${key}=${value}`);
  // Collapse the blank lines a filtered-out key leaves behind, keeping one
  // trailing newline.
  const next = kept.filter((l, i, a) => l.trim() !== '' || i === a.length - 1).join('\n');
  writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`, { mode: 0o600 });
}
