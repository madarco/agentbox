/**
 * Making the BOX (not the engine) reachable over SSH, so `agentbox open`
 * (sshfs), `agentbox code` (Remote-SSH) and `agentbox connect` work exactly as
 * they do for every other provider.
 *
 * The box is a container on someone else's machine, and its sshd is published
 * on THAT machine's loopback (`-p 127.0.0.1:0:22`). So there is no host:port a
 * local ssh could dial directly. The answer is `ProxyJump`: ssh connects to the
 * engine's machine, and the engine dials `127.0.0.1:<published port>` on our
 * behalf — which is precisely the address the box's sshd is listening on from
 * where the jump host stands.
 *
 *     Host agentbox-<box>
 *       HostName 127.0.0.1        # as resolved ON the jump host
 *       Port <published>
 *       User vscode
 *       ProxyJump <engine>        # the ssh destination the box lives on
 *       IdentityFile ~/.agentbox/remote-docker/boxes/<id>/ssh/id_ed25519
 *
 * No `ssh -L` forward is involved: ssh's own transport does the hop, so the
 * alias keeps working in any process (VS Code, sshfs) without AgentBox having
 * to hold a tunnel open for it.
 *
 * The private key never leaves the host. The public half is installed into the
 * box's `authorized_keys` over the ControlMaster we already have.
 */

import type { BoxRecord, SshTargetRecord } from '@agentbox/core';
import { bashScript, quoteShellArg } from '@agentbox/sandbox-cloud';
import { defaultBoxSshDir, mintSshKey } from '@agentbox/sandbox-core';
import { CONTAINER_USER, dockerExecArgv, dockerOnRemote, ensureTunnel } from './remote-docker.js';
import { resolveConnection } from './hosts-registry.js';
import { parseSandboxId } from './target.js';
import { parseDockerPort } from './backend.js';

/** The box image's sshd listens here; we publish it on the engine's loopback. */
const SSH_CONTAINER_PORT = 22;

/**
 * Bring the box's sshd up, make sure it trusts this host's per-box key, and
 * return the connection target. Idempotent — safe to call on every start: the
 * key is reused when present, `authorized_keys` is only appended to when the key
 * isn't already there, and sshd is only launched if it isn't already listening.
 *
 * Returns null (rather than throwing) when sshd doesn't come up, so a failure
 * here degrades `open`/`code` instead of breaking the lifecycle command that
 * triggered it.
 */
export async function resolveBoxSshTarget(box: BoxRecord): Promise<SshTargetRecord | null> {
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) return null;
  const { target: remote, container } = parseSandboxId(sandboxId);
  const conn = await ensureTunnel(sandboxId, remote);

  const key = await mintSshKey(
    defaultBoxSshDir(sandboxId, 'remote-docker'),
    `agentbox-${box.name}`,
  );

  // Install the public key. `grep -q` first so a restart doesn't grow the file
  // without bound. Runs as root because on a nested engine the container's init
  // is uid 0 and ~vscode/.ssh may not exist yet; the chown puts it back.
  const install = [
    `install -d -m 700 -o ${CONTAINER_USER} -g ${CONTAINER_USER} /home/${CONTAINER_USER}/.ssh`,
    `touch /home/${CONTAINER_USER}/.ssh/authorized_keys`,
    `grep -qF ${quoteShellArg(key.publicKey)} /home/${CONTAINER_USER}/.ssh/authorized_keys || echo ${quoteShellArg(key.publicKey)} >> /home/${CONTAINER_USER}/.ssh/authorized_keys`,
    `chown -R ${CONTAINER_USER}:${CONTAINER_USER} /home/${CONTAINER_USER}/.ssh`,
    `chmod 600 /home/${CONTAINER_USER}/.ssh/authorized_keys`,
  ].join(' && ');
  const installRes = await dockerOnRemote(
    conn,
    dockerExecArgv(container, bashScript(install), { user: 'root' }),
  );
  if (installRes.exitCode !== 0) return null;

  // Start sshd (the image ships `agentbox-sshd-start`, which manages the host
  // keys and /run/sshd). Idempotent, and a no-op when it's already listening.
  await dockerOnRemote(
    conn,
    dockerExecArgv(container, bashScript('/usr/local/bin/agentbox-sshd-start'), {
      user: 'root',
    }),
    { timeoutMs: 60_000 },
  );

  // The port docker published on the ENGINE's loopback. Re-read every time: it
  // is ephemeral and gets reassigned whenever the container restarts.
  const portRes = await dockerOnRemote(conn, ['port', container, String(SSH_CONTAINER_PORT)]);
  const port = portRes.exitCode === 0 ? parseDockerPort(portRes.stdout) : null;
  if (port === null) return null;

  return {
    // Resolved on the jump host, not here.
    host: '127.0.0.1',
    port,
    user: CONTAINER_USER,
    identityFile: key.privatePath,
    // The box id bakes an alias; ssh on THIS host can't resolve an AgentBox
    // alias, so the ProxyJump must be the alias's real connection string.
    proxyJump: resolveConnection(remote.spec),
  };
}
