import { execa } from 'execa';
import { mintSshKey } from '@agentbox/sandbox-core';
import { execInBox, publishedHostPort } from './docker.js';

/**
 * Container port the in-box sshd binds. Fixed; the host publishes it on an
 * ephemeral `127.0.0.1:<hostPort>` (`docker run -p 127.0.0.1:0:22`) so it's
 * loopback-only. Stored on the BoxRecord as `sshContainerPort` for symmetry
 * with the VNC/web ports.
 */
export const SSH_CONTAINER_PORT = 22;

export interface SshLaunchResult {
  up: boolean;
  reason?: string;
}

/**
 * Spawn the in-container sshd (`/usr/local/bin/agentbox-sshd-start`) detached as
 * root, then poll container TCP 22 to confirm it bound. Mirrors
 * {@link launchVncDaemon} — best-effort, failure is logged but doesn't fail box
 * creation, and it's idempotent so `agentbox start` can call it blindly. Runs
 * as root (sshd manages /run/sshd + host keys), unlike the vscode-run VNC stack.
 */
export async function launchSshdDaemon(
  container: string,
  timeoutMs = 5000,
): Promise<SshLaunchResult> {
  const result = await execInBox(container, ['/usr/local/bin/agentbox-sshd-start'], {
    user: 'root',
    detach: true,
  });
  if (result.exitCode !== 0) {
    return { up: false, reason: `docker exec failed: ${result.stderr || result.stdout}` };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await execInBox(
      container,
      ['bash', '-lc', '(echo > /dev/tcp/127.0.0.1/22) 2>/dev/null'],
      { user: 'vscode' },
    );
    if (probe.exitCode === 0) return { up: true };
    await new Promise((r) => setTimeout(r, 150));
  }
  return { up: false, reason: `sshd did not bind 22 within ${String(timeoutMs)}ms` };
}

/**
 * Install `publicKey` as vscode's sole authorized_keys entry so the host's
 * per-box private key can SSH in. Written as root (chown to vscode, 0700 dir /
 * 0600 file) — mirrors {@link writeBoxEnvFile}. Overwrites rather than appends:
 * one box, one key, and a fresh key each create means no stale entries linger.
 */
export async function installAuthorizedKey(
  container: string,
  publicKey: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const script =
    'set -e; ' +
    'install -d -m 700 -o vscode -g vscode /home/vscode/.ssh; ' +
    'cat > /home/vscode/.ssh/authorized_keys; ' +
    'chown vscode:vscode /home/vscode/.ssh/authorized_keys; ' +
    'chmod 600 /home/vscode/.ssh/authorized_keys';
  const result = await execa(
    'docker',
    ['exec', '--user', 'root', '-i', container, 'sh', '-c', script],
    { input: publicKey.endsWith('\n') ? publicKey : `${publicKey}\n`, reject: false },
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `docker exec failed (exit ${String(result.exitCode)}): ${(result.stderr ?? '').toString().slice(0, 400)}`,
    };
  }
  return { ok: true };
}

export interface BoxSshSetup {
  /** Ephemeral loopback host port Docker mapped to container :22, or null. */
  sshHostPort: number | null;
  /** Absolute path to the per-box private key (the ssh-config IdentityFile). */
  identityFile: string;
  up: boolean;
  reason?: string;
}

/**
 * End-to-end sshd bring-up for a box: mint (or reuse) the per-box key under
 * `sshDir`, install its public half into the box's authorized_keys, launch
 * sshd, and resolve the published loopback host port. Used on both create and
 * `agentbox start` — `mintSshKey` reuses an existing key and the install +
 * launch are idempotent, so the restart path just re-resolves the (reallocated)
 * host port. Best-effort: a failure surfaces via `up`/`reason`, never throws.
 */
export async function setUpBoxSshd(
  container: string,
  sshDir: string,
  comment: string,
): Promise<BoxSshSetup> {
  const key = await mintSshKey(sshDir, comment);
  const installed = await installAuthorizedKey(container, key.publicKey);
  if (!installed.ok) {
    return { sshHostPort: null, identityFile: key.privatePath, up: false, reason: installed.reason };
  }
  const launch = await launchSshdDaemon(container);
  const sshHostPort = await publishedHostPort(container, SSH_CONTAINER_PORT);
  return { sshHostPort, identityFile: key.privatePath, up: launch.up, reason: launch.reason };
}
