import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pruneOrphanClaudeSshConfigs } from './claude-app-config.js';
import { readState } from './state.js';

/**
 * Host-side SSH-config manager for cloud boxes. AgentBox owns a dedicated file
 * `~/.agentbox/ssh/config` holding one `Host <alias>` block per SSH-capable box,
 * and injects a single managed `Include ~/.agentbox/ssh/config` line into the
 * user's `~/.ssh/config` — so our churn stays out of their hand-maintained
 * config. The owned file is regenerated wholesale from `state.json`
 * (`syncAgentboxSshConfig`), which self-heals stale/destroyed boxes and reads
 * only persisted state (no provider calls, never wakes a paused box).
 *
 * Daytona's SSH gateway authenticates per-token (the User field carries an
 * ephemeral 60-min token from `sb.createSshAccess(60)`), so `agentbox code`
 * re-resolves + re-syncs on every invocation to keep the alias mapped to a live
 * token.
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
   * file (docker localhost sshd, Hetzner). Omit for token-in-User auth
   * (Daytona) — without this field VSCode's Remote-SSH would try ~/.ssh/id_*
   * defaults and fail with "permission denied" against a Hetzner VPS that only
   * trusts the per-box key under `~/.agentbox/boxes/<id>/ssh/id_ed25519`.
   */
  identityFile?: string;
  /**
   * Non-default SSH port. Docker publishes its in-box sshd on an ephemeral
   * `127.0.0.1:<port>`; omit for cloud providers reachable on 22.
   */
  port?: number;
}

function sshConfigPath(): string {
  return join(homedir(), '.ssh', 'config');
}

/** AgentBox-owned SSH config file `Include`d from `~/.ssh/config`. */
export function agentboxSshConfigPath(): string {
  return join(homedir(), '.agentbox', 'ssh', 'config');
}

function stateFilePath(): string {
  return join(homedir(), '.agentbox', 'state.json');
}

const INCLUDE_BEGIN = '# BEGIN agentbox ssh include';
const INCLUDE_END = '# END agentbox ssh include';

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

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
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
  if (opts.port) {
    lines.push(`  Port ${String(opts.port)}`);
  }
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
 * Old versions wrote per-box `# BEGIN agentbox cloud box <alias>` … `# END …`
 * blocks directly into `~/.ssh/config`. We now own `~/.agentbox/ssh/config`, so
 * strip any such inline leftovers whenever we touch `~/.ssh/config`. AgentBox is
 * unreleased → clean removal, no deprecation shim.
 */
function stripLegacyInlineBlocks(contents: string): string {
  const pattern =
    /^# BEGIN agentbox cloud box .*\n[\s\S]*?^# END agentbox cloud box .*\n?/gm;
  return contents.replace(pattern, '');
}

function hasIncludeBlock(contents: string): boolean {
  return (
    contents.includes(INCLUDE_BEGIN) || contents.includes(`Include ${agentboxSshConfigPath()}`)
  );
}

/**
 * Ensure `~/.ssh/config` contains exactly one managed `Include
 * ~/.agentbox/ssh/config` block, prepended to the top. Prepend (not append)
 * because OpenSSH applies the first value it sees per keyword — putting the
 * Include first lets AgentBox's box entries win over any later user `Host *`
 * defaults. Also strips any legacy inline per-box blocks. Idempotent.
 */
export async function ensureSshInclude(): Promise<void> {
  const path = sshConfigPath();
  await fs.mkdir(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 });
  const existing = stripLegacyInlineBlocks(await readFileOrEmpty(path));
  let next = existing;
  if (!hasIncludeBlock(existing)) {
    const block = `${INCLUDE_BEGIN}\nInclude ${agentboxSshConfigPath()}\n${INCLUDE_END}\n`;
    next = existing.length === 0 ? block : `${block}\n${existing}`;
  }
  await fs.writeFile(path, next, { mode: 0o600 });
  // Re-assert mode in case the file existed with broader perms.
  await fs.chmod(path, 0o600);
}

/**
 * Regenerate the AgentBox-owned `~/.agentbox/ssh/config` from `state.json`: one
 * `Host <name>` block per box that carries a resolved `box.ssh` target. Reads
 * only persisted state — no provider calls, never wakes a paused box — so a
 * destroyed box's block simply disappears on the next sync. Also ensures the
 * `Include` line in `~/.ssh/config`.
 */
export async function syncAgentboxSshConfig(statePath: string = stateFilePath()): Promise<void> {
  const state = await readState(statePath);
  const blocks: string[] = [];
  for (const box of state.boxes) {
    const ssh = box.ssh;
    if (!ssh) continue;
    blocks.push(
      buildBlock({
        alias: agentboxAliasFor(box.name),
        hostname: ssh.host,
        user: ssh.user,
        identityFile: ssh.identityFile,
        port: ssh.port,
      }),
    );
  }
  const header =
    '# Managed by agentbox — regenerated on box create/start/destroy.\n' +
    '# Do not edit; changes are overwritten. Disable with `agentbox config set ssh.autoConfig false`.\n\n';
  const path = agentboxSshConfigPath();
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, header + blocks.join('\n'), { mode: 0o600 });
  await fs.chmod(path, 0o600);
  await ensureSshInclude();

  // Sweep Claude desktop's sshConfigs (written by `open --in claude`) of
  // entries whose box is gone — piggybacking on the sync means every destroy
  // path prunes (CLI, hub, dashboard), and any later sync self-heals one that
  // didn't. Aliases are keyed by box NAME (an entry survives a transiently
  // ssh-less record). Best-effort: a corrupt settings.json must never break
  // box lifecycle.
  try {
    pruneOrphanClaudeSshConfigs(new Set(state.boxes.map((b) => agentboxAliasFor(b.name))));
  } catch {
    /* best-effort */
  }
}

/**
 * True when `~/.ssh/config` has a user-authored `Host <alias>` stanza. With the
 * Include prepended, AgentBox's entry is read first so it wins — but a foreign
 * `Host <alias>` is still worth flagging to the user in case they expected their
 * own entry to take effect.
 */
export async function hasUnmanagedHostConflict(alias: string): Promise<boolean> {
  const contents = stripLegacyInlineBlocks(await readFileOrEmpty(sshConfigPath()));
  if (contents === '') return false;
  return contents.split('\n').some((line) => {
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
 * in `~/.agentbox/ssh/config`, if one exists. Used by `inspect` to surface the
 * SSH connection details without re-deriving them from a provider (which would
 * require bringing the box online). Returns undefined when no managed block is
 * present for the alias.
 */
export async function readAgentboxSshAlias(
  alias: string,
): Promise<{ hostName?: string; identityFile?: string } | undefined> {
  const contents = await readFileOrEmpty(agentboxSshConfigPath());
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
