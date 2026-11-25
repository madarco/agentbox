import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CloudBackend, CloudHandle } from '@agentbox/core';

/**
 * The agent env a cloud box's launcher sources (`buildCloudAttachInnerCommand`).
 * The host rewrites it on every create and wake: on a VPS `/run` is tmpfs and
 * a power-off empties it. On other providers (daytona) `/run` is not tmpfs, so
 * a checkpoint can carry the file; the write never leaves a staging copy
 * beside it.
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
export function renderAgentEnvFile(
  env: Readonly<Record<string, string>>,
  account: AccountEnvAuthority = NO_ACCOUNT_AUTHORITY,
): string {
  const quote = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY.test(k) || k in account.set || account.unset.includes(k)) continue;
    lines.push(`[ -n "\${${k}+x}" ] || export ${k}=${quote(v)}`);
  }
  // A named account's keys are the box record's, not the sandbox's: written
  // unconditionally, so a box switched to another account (hub settings 3c)
  // stops using the token its sandbox env was created with.
  for (const [k, v] of Object.entries(account.set)) {
    if (ENV_KEY.test(k)) lines.push(`export ${k}=${quote(v)}`);
  }
  for (const k of account.unset) if (ENV_KEY.test(k)) lines.push(`unset ${k}`);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** Account env keys that override the sandbox env: set these, unset those. */
export interface AccountEnvAuthority {
  set: Record<string, string>;
  unset: string[];
}

export const NO_ACCOUNT_AUTHORITY: AccountEnvAuthority = { set: {}, unset: [] };

/**
 * Defines `asroot`, which runs its arguments under `sudo -n` when sudo exists.
 * A function, not a `$SUDO` variable: daytona's exec shell is zsh, which does
 * not word-split an unquoted `$SUDO`, so `$SUDO rm` looked up a command named
 * `sudo -n` and every privileged step failed silently.
 */
const SUDO_PREFIX = `asroot() { if command -v sudo >/dev/null 2>&1; then sudo -n "$@"; else "$@"; fi; }; `;

const STAGING_PREFIX = '.agent-env-';
const STAGING_DIRS = ['/run/agentbox', '/tmp'] as const;

/**
 * Remove both staging paths of this write, plus any staging copy an earlier
 * failed write left behind (`/tmp/agentbox.agent-env-*` is the pre-fix /tmp
 * name). The sweep skips files younger than a minute so it cannot pull the
 * staging copy out from under a concurrent write to the same box. asroot: an SDK
 * upload may land a copy as another user, which sticky /tmp would not let the
 * box user delete.
 */
function stagingCleanup(staged: readonly string[]): string {
  return (
    `asroot rm -f ${staged.join(' ')}; ` +
    `asroot find ${STAGING_DIRS.join(' ')} -maxdepth 1 -type f ` +
    `\\( -name '${STAGING_PREFIX}*' -o -name 'agentbox${STAGING_PREFIX}*' \\) ` +
    `-mmin +1 -delete 2>/dev/null`
  );
}

/**
 * Write the box's agent env into {@link CLOUD_AGENT_ENV_FILE}, 0600, owned by the
 * box user. The values travel as a file, never on a command line: an exec's argv
 * is readable by any process in the box, and cloud-init user_data or box.env would
 * expose them to the metadata service or every user.
 *
 * Staged as a 0600 local file and uploaded into /run/agentbox, falling back to
 * /tmp when the upload cannot write there. An SDK upload does not keep the
 * mode, and /run is not tmpfs on every provider (daytona), so the staging copy
 * is chmod 600 first thing and both staging paths are removed whatever
 * happens: an upload can write the file and still throw. Moved into place with
 * `install -m 600` as the exec user (the box user on every cloud backend).
 * Always written, even empty, so a wake drops a key the host no longer has.
 */
export async function writeCloudAgentEnvFile(
  backend: CloudBackend,
  handle: CloudHandle,
  env: Readonly<Record<string, string>>,
  account: AccountEnvAuthority = NO_ACCOUNT_AUTHORITY,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agentbox-agent-env-'));
  const local = join(dir, 'agent.env');
  const name = `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`;
  const staged = STAGING_DIRS.map((d) => `${d}/${name}`);
  let cleaned = false;
  try {
    await writeFile(local, renderAgentEnvFile(env, account), { mode: 0o600 });
    await chmod(local, 0o600);
    let remote = staged[0]!;
    try {
      await backend.uploadFile(handle, local, remote);
    } catch {
      remote = staged[1]!;
      await backend.uploadFile(handle, local, remote);
    }
    const r = await backend.exec(
      handle,
      `umask 077; ${SUDO_PREFIX}` +
        // chown before the chmod: an upload whose best-effort chown failed is
        // still owned by the SDK user, and a 0600 file it owns is one the box
        // user's `install` below cannot read.
        `asroot chown "$(id -un):$(id -gn)" ${remote}; asroot chmod 600 ${remote}; ` +
        // The same mkdir + chown the in-box bootstrap does, so a /run/agentbox
        // recreated by root does not make `install` fail.
        `asroot mkdir -p /run/agentbox && asroot chown "$(id -un):$(id -gn)" /run/agentbox; ` +
        `install -m 600 ${remote} ${CLOUD_AGENT_ENV_FILE}.new && mv -f ${CLOUD_AGENT_ENV_FILE}.new ${CLOUD_AGENT_ENV_FILE}; ` +
        `rc=$?; ${stagingCleanup(staged)}; exit $rc`,
    );
    cleaned = true;
    if (r.exitCode !== 0) {
      throw new Error(
        `writing ${CLOUD_AGENT_ENV_FILE} failed (exit ${String(r.exitCode)}): ${(r.stderr || r.stdout).slice(-300)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (!cleaned) {
      try {
        // No retries and a short cap: on an unreachable box the default retries
        // would hold back the real error for minutes.
        await backend.exec(handle, `${SUDO_PREFIX}${stagingCleanup(staged)}; true`, {
          noRetry: true,
          attemptTimeoutMs: 15_000,
        });
      } catch {
        // best-effort: the write already failed and its error is what surfaces
      }
    }
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
    await backend.exec(handle, `${SUDO_PREFIX}asroot rm -f ${CLOUD_AGENT_ENV_FILE}`);
  } catch {
    // best-effort: the box is already in trouble if this exec fails too
  }
}
