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
  /** Host alias the user (and VS Code Remote-SSH) refers to, e.g. `agentbox-cloud-myname`. */
  alias: string;
  /** Daytona SSH gateway, typically `ssh.app.daytona.io`. */
  hostname: string;
  /** Ephemeral Daytona token (used as the SSH User). Rotates every call. */
  user: string;
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

/** Stable alias derived from a box name. Box names are already kebab-safe. */
export function agentboxAliasFor(boxName: string): string {
  return `agentbox-cloud-${boxName}`;
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
  return [
    beginMarker(opts.alias),
    `Host ${opts.alias}`,
    `  HostName ${opts.hostname}`,
    `  User ${opts.user}`,
    `  StrictHostKeyChecking accept-new`,
    `  UserKnownHostsFile /dev/null`,
    `  LogLevel ERROR`,
    endMarker(opts.alias),
    '',
  ].join('\n');
}

export async function writeAgentboxSshAlias(opts: SshAliasOptions): Promise<void> {
  const path = sshConfigPath();
  await fs.mkdir(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 });
  const existing = await readConfig();
  const stripped = stripBlock(existing, opts.alias);
  const separator = stripped.length === 0 || stripped.endsWith('\n') ? '' : '\n';
  const next = `${stripped}${separator}${buildBlock(opts)}`;
  await fs.writeFile(path, next, { mode: 0o600 });
  // Re-assert mode in case the file existed with broader perms.
  await fs.chmod(path, 0o600);
}

export async function removeAgentboxSshAlias(alias: string): Promise<void> {
  const path = sshConfigPath();
  const existing = await readConfig();
  if (existing === '') return;
  const next = stripBlock(existing, alias);
  if (next === existing) return; // no managed block matched
  await fs.writeFile(path, next, { mode: 0o600 });
}
