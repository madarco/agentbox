import type { BoxRecord, Provider } from '@agentbox/core';
import { recordBoxSsh } from './state.js';
import { agentboxAliasFor, parseSshTarget, syncAgentboxSshConfig } from './ssh-config.js';

/**
 * Resolve + persist a cloud box's SSH connection target and regenerate
 * `~/.agentbox/ssh/config`. Lives in sandbox-core (not the CLI) so BOTH the CLI
 * commands AND the hub can write the SSH config after create/start/resume — the
 * caller supplies the already-resolved `Provider` (the CLI via `providerForBox`,
 * the hub via its own provider seam), so this code takes no dependency on either
 * one's provider registry.
 */

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
  /** Optional progress logger for the bring-online path (CLI passes clack's `log.info`). */
  logInfo?: (msg: string) => void;
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
  provider: Provider,
  opts: CloudSshOptions = {},
): Promise<CloudSshAlias> {
  if (!provider.buildAttach) {
    throw new Error(`cloud provider '${provider.name}' does not support SSH attach`);
  }

  if (opts.bringOnline ?? true) {
    const state = await provider.probeState(box);
    if (state === 'paused') {
      opts.logInfo?.('box is paused; resuming');
      await provider.resume(box);
    } else if (state === 'stopped') {
      opts.logInfo?.('box is stopped; starting');
      await provider.start(box);
    } else if (state === 'missing') {
      throw new Error(`cloud sandbox for ${box.name} is missing; was it deleted?`);
    }
  }

  const spec = await provider.buildAttach(box, 'shell', { noTmux: true });
  const target = parseSshTarget(spec.argv);
  if (!target) {
    throw new Error(`could not parse <user>@<host> from cloud SSH argv: ${spec.argv.join(' ')}`);
  }
  const alias = agentboxAliasFor(box.name);
  return { alias, host: target.host, user: target.user, identityFile: target.identityFile };
}

/**
 * Bring a cloud box online, persist its resolved SSH target to `box.ssh`,
 * and regenerate `~/.agentbox/ssh/config` (+ the `~/.ssh/config` Include),
 * returning the connection target. Shared by `agentbox code` (VS Code
 * Remote-SSH), `agentbox open` (sshfs mount), and `agentbox shell --ssh-config`
 * (external app handoff) — all three need the same alias mapped to a live SSH
 * target. These are explicit user actions, so they write regardless of the
 * `ssh.autoConfig` toggle (which only governs the proactive create/start path).
 */
export async function ensureCloudSshAlias(
  box: BoxRecord,
  provider: Provider,
  opts: CloudSshOptions = {},
): Promise<CloudSshAlias> {
  const conn = await resolveCloudSshTarget(box, provider, opts);
  await recordBoxSsh(box.id, {
    host: conn.host,
    user: conn.user,
    identityFile: conn.identityFile,
  });
  await syncAgentboxSshConfig();
  return conn;
}

/**
 * Proactive, default-on SSH-config write on create/start/resume — gated by the
 * `ssh.autoConfig` config key so a user who manages `~/.ssh/config` themselves
 * can opt out. Only persistent-identity providers qualify (Hetzner/DigitalOcean:
 * a per-box identity file that survives across sessions); Daytona's ephemeral
 * token and Docker/Vercel/E2B (no SSH) are skipped. Best-effort: a failure here
 * must never break the lifecycle command/action that triggered it — but it is no
 * longer swallowed silently, so `logWarn` surfaces the reason (CLI stderr, hub log).
 *
 * The box is assumed already online (create just finished, or start/resume
 * brought it up), so `bringOnline: false` avoids a redundant lifecycle pass.
 * Re-resolving on start is what refreshes a Hetzner box's changed public IP.
 */
/**
 * Cloud providers whose `buildAttach` yields a plain `ssh … <user>@<host>` argv
 * pointing AT the box — the only shape `resolveCloudSshTarget` can parse a box
 * SSH target out of. Vercel/E2B have no SSH at all; remote-docker's attach
 * targets the engine's machine, not the box.
 */
const PROVIDERS_WITH_DIRECT_BOX_SSH: readonly string[] = ['hetzner', 'digitalocean', 'daytona'];

export async function autoWriteSshConfig(
  box: BoxRecord,
  provider: Provider,
  enabled: boolean,
  logWarn?: (msg: string) => void,
): Promise<void> {
  if (!enabled) return;
  // A provider whose attach isn't a direct `ssh <user>@<box>` has no target to
  // write. remote-docker's attach lands on the machine running the engine and
  // then `docker exec`s into the box, so there is nothing here to alias — that
  // is a shape, not a failure, and must not warn on every start/unpause.
  if (!PROVIDERS_WITH_DIRECT_BOX_SSH.includes(provider.name)) return;
  try {
    const conn = await resolveCloudSshTarget(box, provider, { bringOnline: false });
    if (!conn.identityFile) return;
    await recordBoxSsh(box.id, {
      host: conn.host,
      user: conn.user,
      identityFile: conn.identityFile,
    });
    await syncAgentboxSshConfig();
  } catch (err) {
    // Best-effort: SSH-config auto-write must never break create/start. But
    // surface the reason rather than swallowing it (this masked the hub-create
    // gap for a whole release).
    logWarn?.(
      `ssh-config auto-write for ${box.name} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
