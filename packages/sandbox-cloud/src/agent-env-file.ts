import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CloudBackend, CloudHandle } from '@agentbox/core';

/**
 * The agent env a cloud box's launcher sources (`buildCloudAttachInnerCommand`).
 * `/run` is tmpfs, so a VPS power-off empties it; the host rewrites it on every
 * create and wake.
 */
export const CLOUD_AGENT_ENV_FILE = '/run/agentbox/agent.env';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Render `env` as lines a `set -a; . file` can source. Each line sets its key
 * only when the environment does not already have it: on daytona, vercel, e2b
 * and remote-docker the sandbox env from create wins, so a wake from a shell
 * with a different `ANTHROPIC_API_KEY` cannot move an existing box onto it; a
 * VPS, which has no sandbox env, still gets every key. Values are
 * single-quoted, so nothing in them expands; a key that is not a shell
 * identifier is dropped rather than allowed to inject a line.
 */
export function renderAgentEnvFile(env: Readonly<Record<string, string>>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY.test(k)) continue;
    lines.push(`[ -n "\${${k}+x}" ] || export ${k}='${v.replace(/'/g, `'\\''`)}'`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

const SUDO_PREFIX = `if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi; `;

/**
 * Write the box's agent env into {@link CLOUD_AGENT_ENV_FILE}, 0600, owned by the
 * box user. The values travel as a file, never on a command line: an exec's argv
 * is readable by any process in the box, and cloud-init user_data or box.env would
 * expose them to the metadata service or every user.
 *
 * Staged as a 0600 local file (scp keeps the mode) and uploaded straight into
 * /run/agentbox, which is tmpfs, so a copy left by a failed move never reaches
 * the disk a snapshot captures. An SDK upload that cannot write there (it runs
 * as another user) falls back to /tmp; those providers already hold the same
 * values in their sandbox env. Moved into place with `install -m 600` as the
 * exec user (the box user on every cloud backend). Always written, even empty,
 * so a wake drops a key the host no longer has.
 */
export async function writeCloudAgentEnvFile(
  backend: CloudBackend,
  handle: CloudHandle,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agentbox-agent-env-'));
  const local = join(dir, 'agent.env');
  const name = `.agent-env-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(local, renderAgentEnvFile(env), { mode: 0o600 });
    await chmod(local, 0o600);
    let remote = `/run/agentbox/${name}`;
    try {
      await backend.uploadFile(handle, local, remote);
    } catch {
      remote = `/tmp/agentbox${name}`;
      await backend.uploadFile(handle, local, remote);
    }
    const r = await backend.exec(
      handle,
      `umask 077; ${SUDO_PREFIX}` +
        // The same mkdir + chown the in-box bootstrap does, so a /run/agentbox
        // recreated by root does not make `install` fail.
        `$SUDO mkdir -p /run/agentbox && $SUDO chown "$(id -un):$(id -gn)" /run/agentbox; ` +
        `install -m 600 ${remote} ${CLOUD_AGENT_ENV_FILE}.new && mv -f ${CLOUD_AGENT_ENV_FILE}.new ${CLOUD_AGENT_ENV_FILE}; ` +
        // sudo: an SDK upload may land the staging copy as another user, which
        // sticky /tmp would not let the box user delete.
        `rc=$?; $SUDO rm -f ${remote}; exit $rc`,
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `writing ${CLOUD_AGENT_ENV_FILE} failed (exit ${String(r.exitCode)}): ${(r.stderr || r.stdout).slice(-300)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Remove {@link CLOUD_AGENT_ENV_FILE}, so a stale copy (carried in by a
 * checkpoint, say) is never sourced after a failed write. Best-effort.
 */
export async function removeCloudAgentEnvFile(
  backend: CloudBackend,
  handle: CloudHandle,
): Promise<void> {
  try {
    await backend.exec(handle, `${SUDO_PREFIX}$SUDO rm -f ${CLOUD_AGENT_ENV_FILE}`);
  } catch {
    // best-effort: the box is already in trouble if this exec fails too
  }
}
