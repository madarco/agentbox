import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Host-side helper for maintaining one `Host <alias>` block per cloud box in
 * `~/.ssh/config`. Daytona's SSH gateway authenticates per-token (the User
 * field carries an ephemeral 60-min token from `sb.createSshAccess(60)`), so
 * we rewrite the block every `agentbox code` invocation to keep the alias
 * mapped to a live token. BEGIN/END markers around each managed block let us
 * coexist with user-authored entries.
 */

export interface SshAliasOptions {
  /** Host alias the user (and VS Code Remote-SSH) refers to — the box name, e.g. `myname`. */
  alias: string;
  /** Daytona SSH gateway, typically `ssh.app.daytona.io`. */
  hostname: string;
  /** Ephemeral Daytona token (used as the SSH User). Rotates every call. */
  user: string;
  /**
   * Per-box private key path for providers that authenticate by identity
   * file (Hetzner). Omit for token-in-User auth (Daytona) — without this
   * field VSCode's Remote-SSH would try ~/.ssh/id_* defaults and fail with
   * "permission denied" against a Hetzner VPS that only trusts the per-box
   * key under `~/.agentbox/boxes/<id>/ssh/id_ed25519`.
   */
  identityFile?: string;
}

function sshConfigPath(): string {
  return join(homedir(), '.ssh', 'config');
}

function beginMarker(alias: string): string {
  return `# BEGIN agentbox cloud box ${alias}`;
}

function endMarker(alias: string): string {
  return `# END agentbox cloud box ${alias}`;
}

/**
 * Stable `~/.ssh/config` Host alias for a box: the box name itself. Box names
 * are already kebab-safe, so `ssh <boxname>` works and external apps (Codex's
 * `codex://…?name=<alias>` deep link, Claude desktop) get a clean, memorable
 * host. Our BEGIN/END-marked managed block keeps this entry isolated from any
 * user-authored `Host <boxname>` so the two coexist.
 */
export function agentboxAliasFor(boxName: string): string {
  return boxName;
}

async function readConfig(): Promise<string> {
  try {
    return await fs.readFile(sshConfigPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Strip an existing managed block for `alias`. Returns the file contents with
 * any block bracketed by our BEGIN/END markers for this alias removed.
 *
 * Anchored at the start of a line (`m` flag) so the preceding newline stays
 * attached to whatever came before — removing a block between two pieces of
 * content must not collapse the separating newline.
 */
function stripBlock(contents: string, alias: string): string {
  const begin = beginMarker(alias);
  const end = endMarker(alias);
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^${escape(begin)}\\n[\\s\\S]*?${escape(end)}\\n?`,
    'gm',
  );
  return contents.replace(pattern, '');
}

function buildBlock(opts: SshAliasOptions): string {
  // `UserKnownHostsFile /dev/null` + `LogLevel ERROR` is the Vagrant / dev-tool
  // convention: many sandboxes sit behind one DNS name, so pinning a host key
  // locally generates noise + false-positive HostKeyVerificationFailed errors.
  const lines: string[] = [
    beginMarker(opts.alias),
    `Host ${opts.alias}`,
    `  HostName ${opts.hostname}`,
    `  User ${opts.user}`,
  ];
  if (opts.identityFile) {
    // `IdentitiesOnly yes` stops ssh-agent from offering unrelated keys
    // first — some sshd configs cap auth attempts and would lock us out
    // before the right key is tried.
    lines.push(`  IdentityFile ${opts.identityFile}`);
    lines.push(`  IdentitiesOnly yes`);
  }
  lines.push(
    `  StrictHostKeyChecking accept-new`,
    `  UserKnownHostsFile /dev/null`,
    `  LogLevel ERROR`,
    endMarker(opts.alias),
    '',
  );
  return lines.join('\n');
}

/**
 * Pre-`agentbox-cloud-<box>` → `<box>` rename, managed blocks were keyed by
 * `agentbox-cloud-<box>`. We strip that block whenever we rewrite/remove the
 * box's alias so upgrades don't leave a stale duplicate Host entry behind.
 */
function legacyAliasFor(alias: string): string {
  return `agentbox-cloud-${alias}`;
}

export async function writeAgentboxSshAlias(opts: SshAliasOptions): Promise<void> {
  const path = sshConfigPath();
  await fs.mkdir(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 });
  const existing = await readConfig();
  const stripped = stripBlock(stripBlock(existing, opts.alias), legacyAliasFor(opts.alias));
  const separator = stripped.length === 0 || stripped.endsWith('\n') ? '' : '\n';
  const next = `${stripped}${separator}${buildBlock(opts)}`;
  await fs.writeFile(path, next, { mode: 0o600 });
  // Re-assert mode in case the file existed with broader perms.
  await fs.chmod(path, 0o600);
}

/**
 * True when `~/.ssh/config` already has a user-authored `Host <alias>` stanza
 * OUTSIDE our managed block. Because the alias is now the bare box name, such a
 * collision matters: OpenSSH applies the first value it sees per keyword, so an
 * earlier user entry can shadow the HostName/IdentityFile/User we append.
 */
export async function hasUnmanagedHostConflict(alias: string): Promise<boolean> {
  const contents = await readConfig();
  if (contents === '') return false;
  // Drop our managed block first so we only see foreign `Host` lines.
  const foreign = stripBlock(contents, alias);
  return foreign.split('\n').some((line) => {
    const m = /^\s*Host\s+(.+?)\s*$/.exec(line);
    if (!m) return false;
    return m[1]!.split(/\s+/).includes(alias);
  });
}

export interface SshTarget {
  user: string;
  host: string;
  /** Path from `-i <path>` if the argv carries one (Hetzner). Undefined for
   *  Daytona where auth is via token-in-User. */
  identityFile?: string;
}

/**
 * Pluck the SSH connect target (and identity file, if any) out of an argv
 * returned by a provider's `attachArgv` / `buildAttach`. The argv shape is
 * `ssh [-i <path>] [-o ...] <user>@<host> [command...]` — we walk from the
 * end to find the user@host token and scan forward for `-i`.
 */
export function parseSshTarget(argv: readonly string[]): SshTarget | undefined {
  let target: { user: string; host: string } | undefined;
  for (let i = argv.length - 1; i >= 0; i--) {
    const v = argv[i];
    if (!v || v.startsWith('-')) continue;
    const at = v.indexOf('@');
    if (at <= 0) continue;
    target = { user: v.slice(0, at), host: v.slice(at + 1) };
    break;
  }
  if (!target) return undefined;
  let identityFile: string | undefined;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '-i') {
      identityFile = argv[i + 1];
      break;
    }
  }
  return { ...target, identityFile };
}

/**
 * Read back the `HostName` / `IdentityFile` from the managed block for `alias`
 * in `~/.ssh/config`, if one exists. Used by `inspect` to surface the SSH
 * connection details without re-deriving them from a provider (which would
 * require bringing the box online). Returns undefined when no managed block is
 * present for the alias.
 */
export async function readAgentboxSshAlias(
  alias: string,
): Promise<{ hostName?: string; identityFile?: string } | undefined> {
  const contents = await readConfig();
  if (contents === '') return undefined;
  const begin = beginMarker(alias);
  const end = endMarker(alias);
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escape(begin)}\\n([\\s\\S]*?)${escape(end)}`, 'm').exec(contents);
  if (!match) return undefined;
  const body = match[1] ?? '';
  const field = (name: string): string | undefined =>
    new RegExp(`^\\s*${name}\\s+(.+)$`, 'm').exec(body)?.[1]?.trim();
  return { hostName: field('HostName'), identityFile: field('IdentityFile') };
}

export async function removeAgentboxSshAlias(alias: string): Promise<void> {
  const path = sshConfigPath();
  const existing = await readConfig();
  if (existing === '') return;
  const next = stripBlock(stripBlock(existing, alias), legacyAliasFor(alias));
  if (next === existing) return; // no managed block matched
  await fs.writeFile(path, next, { mode: 0o600 });
}
