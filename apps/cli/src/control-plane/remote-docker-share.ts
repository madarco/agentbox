/**
 * Sharing one of THIS machine's remote-docker engines with a control box.
 *
 * A registered host is `alias -> ssh string`, and that ssh string is usually an
 * `~/.ssh/config` alias: it means whatever this user's config says, and nothing
 * at all anywhere else. A control box has neither that config nor an ssh agent,
 * so "the hub knows the alias" needs two more things — the `ssh -G` expansion,
 * and a key of its own.
 *
 * The key is MINTED for the hub rather than copied from the user: we install its
 * public half on the engine over the access this machine already has, and send
 * only that private half. So the user's own key never leaves the PC, the grant is
 * visible in `authorized_keys` as `agentbox-hub-<alias>`, and `unshare` can take
 * it back. `--use-existing-key` is the escape hatch for an engine whose
 * `authorized_keys` we cannot write.
 *
 * Shape follows the provider-credential publisher: the PC pushes, the hub
 * validates (it probes ssh + docker with the key before saving), and nothing is
 * echoed back.
 */

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { quoteShellArg } from '@agentbox/sandbox-cloud';
import {
  mintSshKey,
  resolveSshConfigTarget,
  sshExec,
  type SshTargetArgs,
} from '@agentbox/sandbox-core';
import {
  getHostAlias,
  hostKeyDir,
  listHostAliases,
  parseRemoteTarget,
} from '@agentbox/sandbox-remote-docker';
import { HubApiError } from './hub-api-client.js';

export interface ShareOutcome {
  ok: boolean;
  /** One line for the user — success detail, or why nothing happened. */
  message: string;
  /** True when there was simply nothing to do (no control box, or it IS us). */
  skipped?: boolean;
}

/** The ssh target for a destination, read entirely from the user's own config. */
function ownSshTarget(ssh: string): SshTargetArgs {
  const t = parseRemoteTarget(ssh);
  return {
    host: t.host,
    ...(t.user !== undefined ? { user: t.user } : {}),
    ...(t.port !== undefined ? { port: t.port } : {}),
  };
}

/** `[user@]host[:port]` — what we tell the hub it is dialing. */
export function describeConnection(conn: { host: string; user?: string; port?: number }): string {
  const host = conn.host.includes(':') ? `[${conn.host}]` : conn.host;
  return `${conn.user ? `${conn.user}@` : ''}${host}${conn.port !== undefined ? `:${String(conn.port)}` : ''}`;
}

/**
 * Add `publicKey` to the engine's `authorized_keys`, idempotently. Runs over the
 * access this machine already has — which is the whole reason the user could
 * register the host in the first place.
 */
async function installAuthorizedKey(ssh: string, publicKey: string): Promise<void> {
  const key = quoteShellArg(publicKey.trim());
  const cmd =
    'umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ' +
    `{ grep -qxF ${key} ~/.ssh/authorized_keys || printf '%s\\n' ${key} >> ~/.ssh/authorized_keys; }`;
  const res = await sshExec(ownSshTarget(ssh), cmd, { timeoutMs: 30_000 });
  if (res.exitCode !== 0) {
    throw new Error(
      `could not install the hub's key on ${ssh}: ${res.stderr.trim() || `exit ${String(res.exitCode)}`}. ` +
        'Re-run with --use-existing-key to share the key ssh already uses instead.',
    );
  }
}

/** Take the grant back. Best-effort: an unreachable engine must not block unshare. */
async function removeAuthorizedKey(ssh: string, publicKey: string): Promise<boolean> {
  const key = quoteShellArg(publicKey.trim());
  const cmd =
    `test -f ~/.ssh/authorized_keys && grep -vxF ${key} ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.agentbox-tmp && ` +
    'mv ~/.ssh/authorized_keys.agentbox-tmp ~/.ssh/authorized_keys';
  const res = await sshExec(ownSshTarget(ssh), cmd, { timeoutMs: 30_000 }).catch(() => null);
  return res?.exitCode === 0;
}

/** The private key PEM to hand the hub, minting one for it unless told otherwise. */
async function identityForHub(
  alias: string,
  ssh: string,
  existingKeyPath: string | undefined,
  useExisting: boolean,
): Promise<string> {
  if (useExisting) {
    if (!existingKeyPath) {
      throw new Error(
        `--use-existing-key: ssh resolves no identity file for ${ssh}, so there is no key to share`,
      );
    }
    const pem = await readFile(existingKeyPath, 'utf8');
    // An encrypted key is useless to the hub: it runs headless and has nobody to
    // ask for the passphrase. Fail here rather than at the first create.
    if (/ENCRYPTED/.test(pem)) {
      throw new Error(
        `${existingKeyPath} is passphrase-protected — the hub runs headless and cannot unlock it. ` +
          'Share without --use-existing-key so a dedicated key is minted instead.',
      );
    }
    return pem;
  }
  const key = await mintSshKey(hostKeyDir(alias), `agentbox-hub-${alias}`);
  await installAuthorizedKey(ssh, key.publicKey);
  return await readFile(key.privatePath, 'utf8');
}

export interface ShareHostDeps {
  /** Resolved lazily so this module stays importable without a hub. */
  client: {
    addHost: (body: {
      alias: string;
      ssh: string;
      connection: { host: string; user?: string; port?: number };
      identity?: string;
    }) => Promise<void>;
    removeHost: (alias: string) => Promise<{ boxesAffected?: string[] }>;
  };
}

/**
 * Share `alias` with the control box behind `deps.client`. The caller owns
 * target resolution (and the "is there even a control box" question), so this
 * stays testable and can be driven from both the command and the post-deploy
 * sync.
 */
export async function shareHostWith(
  alias: string,
  deps: ShareHostDeps,
  opts: { useExistingKey?: boolean } = {},
): Promise<ShareOutcome> {
  const entry = getHostAlias(alias);
  if (!entry) {
    return {
      ok: false,
      message: `no such remote-docker host alias "${alias}" — register it with \`agentbox remote-docker add\` first`,
    };
  }
  const resolved = await resolveSshConfigTarget(entry.ssh);
  if (!resolved) {
    return {
      ok: false,
      message: `could not expand "${entry.ssh}" with \`ssh -G\` — the control box needs a real hostname, not a local alias`,
    };
  }
  const connection = {
    host: resolved.host,
    ...(resolved.user !== undefined ? { user: resolved.user } : {}),
    ...(resolved.port !== undefined ? { port: resolved.port } : {}),
  };
  let identity: string;
  try {
    identity = await identityForHub(
      alias,
      entry.ssh,
      resolved.identityFile,
      opts.useExistingKey === true,
    );
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  try {
    await deps.client.addHost({ alias, ssh: entry.ssh, connection, identity });
  } catch (err) {
    if (err instanceof HubApiError && /already exists/i.test(err.message)) {
      return { ok: true, skipped: true, message: `the control box already knows "${alias}"` };
    }
    return {
      ok: false,
      message: `the control box refused "${alias}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: true,
    message: `shared "${alias}" (${describeConnection(connection)}) with the control box`,
  };
}

/** Drop `alias` from the control box and revoke the key we minted for it. */
export async function unshareHostFrom(alias: string, deps: ShareHostDeps): Promise<ShareOutcome> {
  let boxesAffected: string[] | undefined;
  try {
    ({ boxesAffected } = await deps.client.removeHost(alias));
  } catch (err) {
    if (!(err instanceof HubApiError && err.status === 404)) {
      return {
        ok: false,
        message: `the control box could not drop "${alias}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  // Revoke the grant, then forget the key. Order matters: the public half is
  // what identifies the line to remove.
  const entry = getHostAlias(alias);
  const pubPath = join(hostKeyDir(alias), 'id_ed25519.pub');
  const publicKey = await readFile(pubPath, 'utf8').catch(() => null);
  let revoked = false;
  if (entry && publicKey) revoked = await removeAuthorizedKey(entry.ssh, publicKey);
  await rm(hostKeyDir(alias), { recursive: true, force: true });
  const affected =
    boxesAffected && boxesAffected.length > 0
      ? ` (${String(boxesAffected.length)} box(es) created there are now unreachable from the hub)`
      : '';
  return {
    ok: true,
    message: publicKey
      ? revoked
        ? `unshared "${alias}" and revoked the hub's key on the engine${affected}`
        : `unshared "${alias}"; could NOT reach the engine to revoke the key — remove the \`agentbox-hub-${alias}\` line from its ~/.ssh/authorized_keys by hand${affected}`
      : `unshared "${alias}"${affected}`,
  };
}

/** Aliases this machine has minted a hub key for — i.e. previously shared. */
export async function locallySharedAliases(): Promise<string[]> {
  const out: string[] = [];
  for (const { alias } of listHostAliases()) {
    const pub = join(hostKeyDir(alias), 'id_ed25519.pub');
    if (
      await readFile(pub, 'utf8')
        .then(() => true)
        .catch(() => false)
    )
      out.push(alias);
  }
  return out;
}

/**
 * Offer to share a just-registered host with the configured control box.
 *
 * Interactive only, and deliberately a question rather than a reflex: unlike a
 * provider credential (which is already the hub's to hold), sharing MUTATES a
 * third machine — it installs a key in the engine's `authorized_keys`. A
 * non-TTY run just prints the command to run.
 *
 * Best-effort throughout: registering the host locally already succeeded, and
 * nothing here may turn that into a failure.
 */
export async function offerShareAfterAdd(alias: string): Promise<void> {
  const [{ localExposedLoopbackUrl, resolveHubApiClient }, { loadEffectiveConfig }, prompts] =
    await Promise.all([
      import('../commands/control-plane.js'),
      import('@agentbox/config'),
      import('../lib/prompt.js'),
    ]);
  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  const url = cfg?.effective.relay.controlPlaneUrl;
  if (!url) return;
  // A control box that IS this machine already reads this registry.
  if ((await localExposedLoopbackUrl().catch(() => null)) !== null) return;

  if (!process.stdin.isTTY) {
    prompts.log.info(
      `Your control box does not know "${alias}" — share it with \`agentbox remote-docker share ${alias}\`.`,
    );
    return;
  }
  const yes = await prompts.confirm({
    message: `Let your control box (${url}) run boxes on "${alias}" too? It mints a key for the hub and installs it on the host.`,
    initialValue: true,
  });
  if (!yes) {
    prompts.log.info(
      `Not shared. Change your mind with \`agentbox remote-docker share ${alias}\`.`,
    );
    return;
  }
  const client = await resolveHubApiClient(undefined, { quiet: true });
  if (!client) {
    prompts.log.warn(
      `No control-box API key here, so "${alias}" was not shared. Run \`agentbox remote-docker share ${alias}\` from the machine that ran \`agentbox hub setup\`.`,
    );
    return;
  }
  const outcome = await shareHostWith(alias, { client });
  if (outcome.ok) prompts.log.success(outcome.message);
  else prompts.log.warn(outcome.message);
}

/**
 * Re-assert every locally-shared host on the control box. Runs at the end of a
 * hub setup/deploy, so a rebuilt control box gets the hosts back without the
 * user remembering which ones they had shared.
 */
export async function syncSharedHosts(
  urlFlag: string | undefined,
  onLog: (line: string) => void,
): Promise<void> {
  const aliases = await locallySharedAliases();
  if (aliases.length === 0) return;
  const { localExposedLoopbackUrl, resolveHubApiClient } =
    await import('../commands/control-plane.js');
  if ((await localExposedLoopbackUrl().catch(() => null)) !== null) return;
  const client = await resolveHubApiClient(urlFlag, { quiet: true });
  if (!client) {
    onLog(
      `Could not reach the control box, so ${String(aliases.length)} shared docker host(s) were not re-registered. Run \`agentbox remote-docker share <alias>\` once it is up.`,
    );
    return;
  }
  for (const alias of aliases) {
    const outcome = await shareHostWith(alias, { client });
    onLog(outcome.message);
  }
}
