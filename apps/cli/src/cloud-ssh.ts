import { log } from '@clack/prompts';
import type { BoxRecord } from '@agentbox/core';
import { providerForBox } from './provider/registry.js';
import { agentboxAliasFor, parseSshTarget, writeAgentboxSshAlias } from './ssh-config.js';

export interface CloudSshAlias {
  /** Host alias written to `~/.ssh/config` (the box name). */
  alias: string;
  /** SSH host — VPS IP (Hetzner) or gateway domain (Daytona). */
  host: string;
  /** SSH user — `vscode` (Hetzner) or an ephemeral token (Daytona). */
  user: string;
  /**
   * Per-box private key path when the provider authenticates by identity file
   * (Hetzner). Undefined for token-in-User providers (Daytona) — callers that
   * need a persistent connection (external apps) should treat its absence as
   * "not supported".
   */
  identityFile?: string;
}

export interface CloudSshOptions {
  /**
   * Bring the box online (resume/start) before resolving the target. Default
   * true. Callers that already brought the box online (e.g. `agentbox code`
   * after its own wait-ready) pass false to skip a redundant lifecycle pass.
   */
  bringOnline?: boolean;
}

/**
 * Resolve a cloud box's SSH connection target WITHOUT touching `~/.ssh/config`.
 * Lets callers inspect the target (e.g. gate on a persistent `identityFile`)
 * before deciding to persist an alias.
 *
 * The SSH-support check runs FIRST, before any lifecycle action — so an
 * unsupported provider (e.g. Docker, which has no `buildAttach`) errors without
 * resuming/starting the box. `buildAttach(..., { noTmux: true })` yields the
 * plain `ssh ... <user>@<host>` argv; the identity path (if any) is parsed
 * straight out of it so we never hardcode a provider-specific key path.
 */
export async function resolveCloudSshTarget(
  box: BoxRecord,
  opts: CloudSshOptions = {},
): Promise<CloudSshAlias> {
  const p = await providerForBox(box);
  if (!p.buildAttach) {
    throw new Error(`cloud provider '${p.name}' does not support SSH attach`);
  }

  if (opts.bringOnline ?? true) {
    const state = await p.probeState(box);
    if (state === 'paused') {
      log.info('box is paused; resuming');
      await p.resume(box);
    } else if (state === 'stopped') {
      log.info('box is stopped; starting');
      await p.start(box);
    } else if (state === 'missing') {
      throw new Error(`cloud sandbox for ${box.name} is missing; was it deleted?`);
    }
  }

  const spec = await p.buildAttach(box, 'shell', { noTmux: true });
  const target = parseSshTarget(spec.argv);
  if (!target) {
    throw new Error(`could not parse <user>@<host> from cloud SSH argv: ${spec.argv.join(' ')}`);
  }
  const alias = agentboxAliasFor(box.name);
  return { alias, host: target.host, user: target.user, identityFile: target.identityFile };
}

/**
 * Bring a cloud box online and (re)write its `~/.ssh/config` alias, returning
 * the connection target. Shared by `agentbox code` (VS Code Remote-SSH),
 * `agentbox open` (sshfs mount), and `agentbox shell --ssh-config` (external
 * app handoff) — all three need the same alias mapped to a live SSH target.
 */
export async function ensureCloudSshAlias(
  box: BoxRecord,
  opts: CloudSshOptions = {},
): Promise<CloudSshAlias> {
  const conn = await resolveCloudSshTarget(box, opts);
  await writeAgentboxSshAlias({
    alias: conn.alias,
    hostname: conn.host,
    user: conn.user,
    identityFile: conn.identityFile,
  });
  return conn;
}
