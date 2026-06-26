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

/**
 * Bring a cloud box online and resolve its SSH connection target WITHOUT
 * touching `~/.ssh/config`. Lets callers inspect the target (e.g. gate on a
 * persistent `identityFile`) before deciding to persist an alias.
 *
 * `buildAttach(..., { noTmux: true })` yields the plain `ssh ... <user>@<host>`
 * argv; the identity path (if any) is parsed straight out of it so we never
 * hardcode a provider-specific key path. Bringing the box online is idempotent
 * — a probe of an already-running box is a no-op.
 */
export async function resolveCloudSshTarget(box: BoxRecord): Promise<CloudSshAlias> {
  const p = await providerForBox(box);
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

  if (!p.buildAttach) {
    throw new Error(`cloud provider '${p.name}' does not support SSH attach`);
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
export async function ensureCloudSshAlias(box: BoxRecord): Promise<CloudSshAlias> {
  const conn = await resolveCloudSshTarget(box);
  await writeAgentboxSshAlias({
    alias: conn.alias,
    hostname: conn.host,
    user: conn.user,
    identityFile: conn.identityFile,
  });
  return conn;
}
