/**
 * AWS env auto-loader — mirrors `ensureDigitalOceanEnvLoaded()`.
 *
 * The EC2 client resolves credentials through the AWS SDK's default provider
 * chain, which reads `process.env`. We pull our managed keys in from
 * `~/.agentbox/secrets.env` so the client Just Works after the user runs
 * `agentbox aws login` once.
 *
 * Unlike the single-token providers, most of what we persist is a *pointer*,
 * not a secret: `AWS_PROFILE` + `AWS_REGION` name a profile the SDK then
 * resolves out of `~/.aws` (including an SSO cache). The static-key pair is
 * the fallback branch for users with no `~/.aws`.
 *
 * Lookup order (first wins; `process.env` is never overwritten):
 *   1. `process.env` — already set in the shell, or by an outer AgentBox.
 *   2. `~/.agentbox/secrets.env` — written by `agentbox aws login`.
 *
 * Project-level `.env` / `.env.local` are intentionally NOT consulted: those
 * belong to the app being developed, and AWS keys there are meant for in-box
 * work, not for the host CLI to harvest and provision instances with.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const AWS_KEYS = [
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;

let loaded = false;

export function ensureAwsEnvLoaded(): void {
  if (loaded) return;
  loaded = true;
  importAwsFromFile(resolve(homedir(), '.agentbox', 'secrets.env'));
}

/** Test seam: forget that we've loaded, so a fixture HOME can be re-read. */
export function resetAwsEnvLoadedForTests(): void {
  loaded = false;
}

function importAwsFromFile(path: string): void {
  if (!existsSync(path)) return;
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const parsed = parseEnvFile(body);

  // A shell that already exports AWS_ACCESS_KEY_ID means the user is driving a
  // specific identity right now; importing our stored AWS_PROFILE on top of it
  // would silently switch accounts under them (the SDK prefers the static keys,
  // but the mixed state is confusing and region would come from us). Treat the
  // shell's static-key pair as authoritative and import nothing but the region.
  const shellHasStaticKeys =
    typeof process.env.AWS_ACCESS_KEY_ID === 'string' &&
    process.env.AWS_ACCESS_KEY_ID.length > 0;

  for (const key of AWS_KEYS) {
    if (process.env[key] !== undefined) continue;
    if (shellHasStaticKeys && key === 'AWS_PROFILE') continue;
    const value = parsed[key];
    if (typeof value === 'string' && value.length > 0) {
      process.env[key] = value;
    }
  }
}

/**
 * Minimal `.env` parser: handles `KEY=value`, `KEY="value with spaces"`,
 * `KEY='value with $special chars'`, `export KEY=value`, blank lines, and
 * `#` comments. Same shape as the sibling providers' parsers — kept local
 * rather than shared to avoid a cross-provider import cycle.
 */
export function parseEnvFile(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
