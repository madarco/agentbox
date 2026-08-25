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
import { loadEffectiveConfig } from '@agentbox/config';
import { quoteShellArg } from '@agentbox/sandbox-cloud';
import { log } from '../lib/prompt.js';
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

/**
 * Undo {@link identityForHub}: drop the `agentbox-hub-<alias>` line from the
 * engine and delete our copy of the key. Returns whether the engine line went.
 */
async function revokeMintedKey(alias: string, ssh: string): Promise<boolean> {
  const publicKey = await readFile(join(hostKeyDir(alias), 'id_ed25519.pub'), 'utf8').catch(
    () => null,
  );
  const revoked = publicKey ? await removeAuthorizedKey(ssh, publicKey) : false;
  await rm(hostKeyDir(alias), { recursive: true, force: true });
  return revoked;
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
    const detail = err instanceof Error ? err.message : String(err);
    // Roll the grant back ONLY on a definitive refusal. A 4xx means the hub
    // probed the engine, declined, and saved nothing — and a minted key left
    // behind is not inert: `locallySharedAliases` reads it as "the control box
    // has this engine", so every later create would route to a hub with no such
    // alias, with local docker gated off.
    //
    // A timeout or a 5xx is ambiguous, and `syncSharedHosts` replays this on
    // every hub setup / deploy / update — so an unreachable hub must be INERT
    // here. Revoking then would delete a working grant for a host the control
    // box still holds, breaking exactly the creates the share enabled.
    const refused = err instanceof HubApiError && err.status >= 400 && err.status < 500;
    if (refused && opts.useExistingKey !== true) await revokeMintedKey(alias, entry.ssh);
    return {
      ok: false,
      message: refused
        ? `the control box refused "${alias}": ${detail}`
        : `could not reach the control box to share "${alias}": ${detail} — the key stays in place; re-run \`agentbox remote-docker share ${alias}\` once it is up`,
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
  const publicKey = await readFile(join(hostKeyDir(alias), 'id_ed25519.pub'), 'utf8').catch(
    () => null,
  );
  const revoked = entry ? await revokeMintedKey(alias, entry.ssh) : false;
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
 * Share a just-registered host with the configured control box, automatically.
 *
 * Not a prompt: a host registered while a control box is configured but never
 * handed to it is a half-configured host — it works from this laptop and
 * silently nowhere else, which is exactly the confusion this whole feature
 * exists to remove. `remote-docker add --no-share` opts out.
 *
 * It does mutate the engine (one `authorized_keys` line, tagged
 * `agentbox-hub-<alias>`), so it says so rather than doing it quietly.
 *
 * Best-effort throughout: the host IS registered locally by the time this runs,
 * and nothing here may turn that into a failure.
 */
export async function shareAfterAdd(alias: string): Promise<void> {
  // control-plane.js is lazy (it sits in a module cycle with hub.js); the prompt
  // module is NOT — a dynamic import of it makes esbuild give up on the
  // `export * from '@clack/prompts'` re-export and the bundle fails to build.
  const { localExposedLoopbackUrl, resolveHubApiClient } =
    await import('../commands/control-plane.js');
  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  const url = cfg?.effective.relay.controlPlaneUrl;
  if (!url) return;
  // A control box that IS this machine already reads this registry.
  if ((await localExposedLoopbackUrl().catch(() => null)) !== null) return;

  const client = await resolveHubApiClient(undefined, { quiet: true });
  if (!client) {
    log.warn(
      `Your control box (${url}) does not know "${alias}" — no API key here to tell it. Run \`agentbox remote-docker share ${alias}\` from the machine that ran \`agentbox hub setup\`.`,
    );
    return;
  }
  log.info(`sharing "${alias}" with your control box (${url})…`);
  const outcome = await shareHostWith(alias, { client });
  if (outcome.ok) {
    log.success(
      outcome.skipped
        ? outcome.message
        : `${outcome.message} — it authorizes a key named \`agentbox-hub-${alias}\` on the host; \`agentbox remote-docker unshare ${alias}\` takes it back`,
    );
  } else {
    log.warn(
      `${outcome.message}\nThe host is registered here, so \`agentbox docker:${alias} …\` still works from this machine. Retry the hand-off with \`agentbox remote-docker share ${alias}\`.`,
    );
  }
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

/** Bound on every control-box probe: this runs inside interactive create paths. */
const CONTROL_BOX_STATUS_MS = 5000;

/**
 * Whether the configured control box has `alias` registered — i.e. whether it
 * can SSH to that engine as itself.
 *
 * The one question that decides both halves of the feature: `prepare` uses it to
 * pick which hub bakes, and `create` uses it to decide whether the box can be
 * built on the control box at all. Best-effort by design: an unreachable control
 * box answers "no", and the caller falls back to this machine — which still
 * reaches the same engine, just with the laptop in the loop.
 */
export async function controlBoxKnowsHost(
  alias: string | undefined,
  effective: { relay?: { controlPlaneUrl?: string } },
): Promise<boolean> {
  if (!alias || !effective.relay?.controlPlaneUrl) return false;
  const [{ resolveHubApiTarget }, { HubApiClient }, { deadlineFetch, hostReachable }] =
    await Promise.all([
      import('../commands/control-plane.js'),
      import('./hub-api-client.js'),
      import('@agentbox/sandbox-cloud'),
    ]);
  const target = await resolveHubApiTarget(undefined, { quiet: true }).catch(() => null);
  if (!target) return false;
  if (!(await hostReachable(target.url, CONTROL_BOX_STATUS_MS))) return false;
  const client = new HubApiClient({
    ...target,
    fetchImpl: deadlineFetch(AbortSignal.timeout(CONTROL_BOX_STATUS_MS)),
  });
  const hosts = await client.listHosts().catch(() => null);
  return !!hosts?.some((h) => h.alias === alias);
}

/**
 * Can the control box build this create itself?
 *
 * True for the real clouds, as before. Also true for a `docker:<alias>` engine
 * the control box has REGISTERED: a remote-docker box bind-mounts nothing and is
 * seeded over SSH, so the only question was ever "can the hub reach that
 * machine" — and a shared host is exactly the answer being yes.
 */
export async function hubCanRunEngine(
  providerName: string,
  remoteHost: string | undefined,
  effective: { relay?: { controlPlaneUrl?: string } },
): Promise<boolean> {
  const { isHubRoutableProvider } = await import('@agentbox/config');
  if (isHubRoutableProvider(providerName)) return true;
  if (providerName !== 'remote-docker' || !remoteHost) return false;
  // Fast path, no network: if THIS machine shared the engine, the control box
  // has it. Saves a round-trip on the common case and keeps the answer honest
  // offline. It is load-bearing that a FAILED share leaves nothing behind
  // (`shareHostWith` rolls the minted key back) — nothing downstream re-checks,
  // so a stale key here would route creates to a hub that has no such alias.
  if ((await locallySharedAliases()).includes(remoteHost)) return true;
  return await controlBoxKnowsHost(remoteHost, effective);
}

/** Why a remote-docker create stayed local, in words the user can act on. */
export function unsharedHostReason(remoteHost: string | undefined): string {
  return remoteHost
    ? `the control box has no \`${remoteHost}\` host registered — building from this machine (share it with \`agentbox remote-docker share ${remoteHost}\`)`
    : 'no remote-docker host to hand the control box';
}
