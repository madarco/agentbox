/**
 * `~/.agentbox/remote-docker-hosts.json` — the alias registry.
 *
 * A remote engine is addressed by a short **alias** (`macmini`), not by its raw
 * SSH connection string. The alias is what gets baked into a box's sandbox id
 * (`<alias>/<container>`); the connection string is resolved from this registry
 * at connection time. That indirection is the whole point: `remote-docker update
 * <alias> <new-ssh>` remints the connection and every existing box created against
 * that alias follows it — no stale IP baked into an id.
 *
 * Two resolution modes:
 *   - `resolveConnection(ref)` — LENIENT, for connection time. A registered alias
 *     resolves to its ssh string; anything else passes through unchanged, so a box
 *     whose id predates this registry (or names a raw/ssh-config destination) stays
 *     reachable.
 *   - `requireHostAlias(ref)` — STRICT, for entry points (create / prepare /
 *     doctor). An unregistered reference throws — you must `add` it first. This is
 *     what enforces the alias-only model for NEW boxes without stranding old ones.
 *
 * Shape mirrors `prepared-state.ts` (a provider-owned `Record<string,T>` JSON doc),
 * but with its own filename and inline atomic read/write. `homedir()` is resolved
 * at call time so tests can redirect `$HOME`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve as pathResolve } from 'node:path';

const SCHEMA = 1;

export interface RemoteHostEntry {
  /** The SSH connection string: `[user@]host[:port]` or an `~/.ssh/config` alias. */
  ssh: string;
  createdAt: string;
  updatedAt?: string;
}

export interface RemoteHostsRegistry {
  schema: number;
  /** Keyed by alias — the user-facing name, also what a box's sandbox id bakes. */
  hosts: Record<string, RemoteHostEntry>;
}

/** Aliases must be a plain name: no `@`/`:` (would look like a connection string),
 * no `/` (sandbox-id separator), no whitespace. Keeps them unambiguous + id-safe. */
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidAlias(alias: string): boolean {
  return ALIAS_RE.test(alias);
}

export function assertValidAlias(alias: string): void {
  if (!isValidAlias(alias)) {
    throw new Error(
      `invalid host alias ${JSON.stringify(alias)} — use a plain name (letters, digits, \`.\`, \`_\`, \`-\`; no \`@\`, \`:\`, \`/\` or spaces)`,
    );
  }
}

function registryPath(): string {
  return pathResolve(homedir(), '.agentbox', 'remote-docker-hosts.json');
}

export function readHostsRegistry(): RemoteHostsRegistry | null {
  const path = registryPath();
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const parsed = raw as Partial<RemoteHostsRegistry>;
  if (parsed.schema !== SCHEMA || typeof parsed.hosts !== 'object' || parsed.hosts === null) {
    return null;
  }
  return { schema: SCHEMA, hosts: parsed.hosts };
}

/** Atomic write (tmp + rename), 0600 — same hygiene as `writePreparedStateRaw`. */
export function writeHostsRegistry(reg: RemoteHostsRegistry): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify({ schema: SCHEMA, hosts: reg.hosts }, null, 2) + '\n';
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

export function getHostAlias(alias: string): RemoteHostEntry | undefined {
  return readHostsRegistry()?.hosts[alias];
}

/** All registered aliases, sorted by name for stable `list` output. */
export function listHostAliases(): Array<{ alias: string; entry: RemoteHostEntry }> {
  const reg = readHostsRegistry();
  if (!reg) return [];
  return Object.entries(reg.hosts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, entry]) => ({ alias, entry }));
}

/**
 * Register or re-point an alias. Preserves `createdAt` on an update and stamps
 * `updatedAt`. Caller validates the alias name + probes the connection first.
 */
export function upsertHostAlias(alias: string, ssh: string): void {
  const reg = readHostsRegistry() ?? { schema: SCHEMA, hosts: {} };
  const existing = reg.hosts[alias];
  const now = new Date().toISOString();
  reg.hosts[alias] = existing
    ? { ...existing, ssh, updatedAt: now }
    : { ssh, createdAt: now };
  writeHostsRegistry(reg);
}

/** Drop an alias. Returns whether it was present. */
export function removeHostAlias(alias: string): boolean {
  const reg = readHostsRegistry();
  if (!reg || !(alias in reg.hosts)) return false;
  const hosts = { ...reg.hosts };
  delete hosts[alias];
  writeHostsRegistry({ schema: SCHEMA, hosts });
  return true;
}

/**
 * Connection-time resolution (LENIENT): a registered alias → its ssh string;
 * anything else → unchanged, so pre-registry / raw-baked box ids stay reachable.
 */
export function resolveConnection(ref: string): string {
  return getHostAlias(ref)?.ssh ?? ref;
}

/**
 * Entry-point resolution (STRICT): a registered alias → its entry; otherwise
 * throw. This is what makes the model alias-only for anything that CREATES a
 * reference (create / prepare / doctor) without stranding existing boxes.
 */
export function requireHostAlias(ref: string): RemoteHostEntry {
  const entry = getHostAlias(ref);
  if (!entry) {
    throw new Error(
      `no such remote-docker host alias ${JSON.stringify(ref)} — register it with \`agentbox remote-docker add <name> <[user@]host[:port]>\``,
    );
  }
  return entry;
}
