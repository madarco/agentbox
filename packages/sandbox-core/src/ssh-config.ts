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
  /**
   * `ProxyJump` destination for a box reachable only through another machine —
   * remote-docker's box is a container on a remote engine, so ssh hops through
   * that engine and dials the published sshd port on its loopback.
   */
  proxyJump?: string;
  /** Comment-marker flavor; defaults to `cloud box`. */
  kind?: BlockKind;
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

/** Deploy record written by `agentbox hub setup --deploy hetzner` / `hub deploy hetzner`. */
export function controlPlaneDeployPath(): string {
  return join(homedir(), '.agentbox', 'control-plane', 'deploy.json');
}

/**
 * Host alias for the deployed control box. Fixed rather than derived: there is
 * at most one deployed hub per machine, and a stable `ssh agentbox-hub` is the
 * whole point — the VPS is otherwise reachable only via a per-deploy key buried
 * under `~/.agentbox/control-plane/ssh/<stamp>/`.
 */
export const AGENTBOX_HUB_SSH_ALIAS = 'agentbox-hub';

const INCLUDE_BEGIN = '# BEGIN agentbox ssh include';
const INCLUDE_END = '# END agentbox ssh include';

function beginMarker(alias: string, kind: BlockKind = 'cloud box'): string {
  return `# BEGIN agentbox ${kind} ${alias}`;
}

function endMarker(alias: string, kind: BlockKind = 'cloud box'): string {
  return `# END agentbox ${kind} ${alias}`;
}

/** What a managed block describes — only the comment markers differ. */
type BlockKind = 'cloud box' | 'control box';

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
    beginMarker(opts.alias, opts.kind),
    `Host ${opts.alias}`,
    `  HostName ${opts.hostname}`,
    `  User ${opts.user}`,
  ];
  if (opts.port) {
    lines.push(`  Port ${String(opts.port)}`);
  }
  if (opts.proxyJump) {
    // The jump host dials `HostName:Port` itself, which is why a box published
    // on the engine's loopback is reachable at all.
    lines.push(`  ProxyJump ${opts.proxyJump}`);
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
    endMarker(opts.alias, opts.kind),
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
  const pattern = /^# BEGIN agentbox cloud box .*\n[\s\S]*?^# END agentbox cloud box .*\n?/gm;
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
 * Where a control-box deploy gets the hub from.
 *
 * `package` (the default) installs the published `@madarco/agentbox` on the VPS
 * and runs the standalone hub it already ships at `runtime/hub/apps/hub/server.js`
 * — the same bundle `agentbox hub` spawns locally. The control box and the PC
 * that deployed it then run the identical published build by construction, which
 * also makes their base-image fingerprints match byte-for-byte.
 *
 * `source` clones the monorepo onto the VPS and builds it there. The escape hatch
 * for deploying unreleased code, and what a dev build (no published version to
 * install) falls back to.
 *
 * Lives here, next to the record that carries it, so the deploy record stays a
 * plain sandbox-core type — provider packages depend on this one, not the reverse.
 */
export type HubDeploySource =
  | { kind: 'package'; spec: string }
  | { kind: 'source'; repoUrl: string; repoRef: string };

/**
 * The record `agentbox hub deploy` persists to `deploy.json`. Every field is
 * optional because it is also written mid-deploy (before the hub is healthy)
 * and read back by later commands that must tolerate an older/partial file.
 */
export interface ControlPlaneDeployRecord {
  provider?: string;
  /** Public URL the hub serves on, e.g. `https://<ip>.sslip.io`. */
  url?: string;
  serverId?: number;
  ip?: string;
  domain?: string;
  /**
   * Hetzner firewall ids are numeric; DigitalOcean's are UUID strings — one field
   * carries either, so the destroy/update paths tolerate both providers.
   */
  firewallId?: number | string;
  /**
   * DigitalOcean only: the unique per-deploy tag the control-plane firewall is
   * bound to (created before the droplet so the firewall auto-applies at boot).
   * Destroy deletes it once the firewall is gone, or it leaks as an empty tag.
   */
  firewallTag?: string;
  /** Holds `id_ed25519` (+ `.pub`, `known_hosts`) — the only key that VPS trusts. */
  sshKeyDir?: string;
  /**
   * What was deployed. Nothing else records the running build — the VPS keeps no
   * version marker, and in package mode there is not even a git checkout to
   * `rev-parse` — so without this a control box is unattributable after the fact.
   */
  source?: HubDeploySource;

  // --- `provider: 'local'` only (agentbox hub expose) -----------------------
  // A control box that IS this machine's own hub, flipped to the deployed
  // profile rather than a separate VPS. These fields describe how it was
  // exposed so `hub start` / autostart / update / destroy reconstruct the mode
  // from disk. `sshKeyDir` is intentionally absent (no ssh alias block).
  /**
   * The box-facing URL: what a cloud box is told to call home on
   * (`AGENTBOX_HUB_PUBLIC_URL`). The LAN address, or the tunnel URL. Distinct
   * from the CLI-facing loopback the local shortcut uses.
   */
  publicUrl?: string;
  /** Port the hub binds (default 8787). */
  port?: number;
  /** Bind address (`0.0.0.0` LAN, `127.0.0.1` loopback-only). */
  bind?: string;
  /** The tunnel kind in front of the hub, if any: `cloudflare` | `tailscale`. */
  tunnel?: string;
  /** Whether an autostart unit (launchd/systemd) was installed. */
  autostart?: boolean;
  /**
   * The admin PC's egress CIDR at expose time — added to a hetzner box's
   * firewall so this machine can still SSH boxes the hub creates. Stored (not
   * recomputed) so the exposed-env assembly stays a pure function of the record.
   */
  adminCidr?: string;
}

/**
 * The managed block for the deployed control box, or '' when there is no deploy
 * record (or it predates `sshKeyDir`). Read from `deploy.json` rather than
 * `state.json` because the control box is not a box — it is the machine that
 * *runs* the hub, and nothing else in the CLI models it.
 */
async function controlPlaneBlock(deployPath: string): Promise<string> {
  let record: ControlPlaneDeployRecord;
  try {
    record = JSON.parse(await fs.readFile(deployPath, 'utf8')) as ControlPlaneDeployRecord;
  } catch {
    // Absent (never deployed) or corrupt — either way there is no host to add.
    return '';
  }
  if (!record.ip || !record.sshKeyDir) return '';
  return buildBlock({
    kind: 'control box',
    alias: AGENTBOX_HUB_SSH_ALIAS,
    hostname: record.ip,
    // The deploy provisions stock Ubuntu and works as root throughout (docker
    // compose, /opt/agentbox); no unprivileged user is ever created.
    user: 'root',
    identityFile: join(record.sshKeyDir, 'id_ed25519'),
  });
}

/**
 * Regenerate the AgentBox-owned `~/.agentbox/ssh/config` from `state.json`: one
 * `Host <name>` block per box that carries a resolved `box.ssh` target, plus a
 * `Host agentbox-hub` block for the deployed control box (from `deploy.json`).
 * Reads only persisted state — no provider calls, never wakes a paused box — so
 * a destroyed box's block simply disappears on the next sync. Also ensures the
 * `Include` line in `~/.ssh/config`.
 */
export async function syncAgentboxSshConfig(
  statePath: string = stateFilePath(),
  deployPath: string = controlPlaneDeployPath(),
): Promise<void> {
  const state = await readState(statePath);
  const blocks: string[] = [];
  const aliases = new Set<string>();
  for (const box of state.boxes) {
    const ssh = box.ssh;
    if (!ssh) continue;
    aliases.add(agentboxAliasFor(box.name));
    blocks.push(
      buildBlock({
        alias: agentboxAliasFor(box.name),
        hostname: ssh.host,
        user: ssh.user,
        identityFile: ssh.identityFile,
        port: ssh.port,
        proxyJump: ssh.proxyJump,
      }),
    );
  }
  // A box literally named `agentbox-hub` would otherwise emit a second `Host
  // agentbox-hub`; OpenSSH takes the first, so the box (the more specific,
  // user-created thing) wins and we skip ours rather than write a dead stanza.
  if (!aliases.has(AGENTBOX_HUB_SSH_ALIAS)) {
    const hub = await controlPlaneBlock(deployPath);
    if (hub) blocks.push(hub);
  }
  const header =
    '# Managed by agentbox — regenerated on box create/start/destroy and hub deploy.\n' +
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
