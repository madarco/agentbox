// A docker box's OWN credential file (docs/hot-switch-subscriptions-plan.md).
//
// An agent's config volume belongs to an account and is shared by every box on
// it, so a login written there moves all of them. Each box instead gets a host
// file bind-mounted over the agent's `credential.boxAbsPath`. Switching the box
// to another login is a write to that file, and the fan-out writes it for the
// boxes on the account.
//
// Writes go IN PLACE. A file bind pins the inode, so a tmp + rename on the host
// would leave the container reading the old file. Inside the box, claude's own
// rename onto the mount fails with EBUSY and it falls back to writing in place
// (measured), so its refreshes land here too, never in the volume.
import { chmod, mkdir, open, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { execa } from 'execa';
import { BOX_USER } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { boxRunDirFor, type BoxDirRef } from './sync/host-export.js';

/** Host path of `agent`'s per-box credential file. Throws for an agent without a credential. */
export function boxCredentialFile(box: BoxDirRef, agent: string): string {
  const cred = resolveAgentSpec(agent).credential;
  if (!cred) throw new Error(`agent '${agent}' declares no credential`);
  return join(boxRunDirFor(box), 'credentials', agent, basename(cred.boxRelPath));
}

/** `-v` spec mounting the per-box file over the agent's in-box credential path. */
export function boxCredentialMount(box: BoxDirRef, agent: string): string {
  const cred = resolveAgentSpec(agent).credential;
  if (!cred) throw new Error(`agent '${agent}' declares no credential`);
  return `${boxCredentialFile(box, agent)}:${cred.boxAbsPath}`;
}

/**
 * Write `content` into the box's own credential file, in place. Returns its path.
 *
 * Mode 0666 inside a 0700 dir: the box user is uid 1000, which is not the host
 * user on every Linux host (nor under rootless docker), and it must both read
 * the file and write its refreshes back. A bind ignores the host dir's mode, so
 * the dir keeps other host users out while the box can still write.
 */
export async function writeBoxCredentialFile(
  box: BoxDirRef,
  agent: string,
  content: string,
): Promise<string> {
  const file = boxCredentialFile(box, agent);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700).catch(() => {});
  const fh = await open(file, 'a+', 0o666).then(async (h) => {
    await h.close();
    return open(file, 'r+');
  });
  try {
    const data = Buffer.from(content, 'utf8');
    // One write covering the old length too: a shorter blob is padded with
    // spaces (JSON allows trailing whitespace), so a read between this write
    // and the truncate sees the whole new blob, never the new one plus the old
    // tail, and never an empty file (which the agent takes as logged out).
    const old = (await fh.stat()).size;
    const padded =
      data.length >= old ? data : Buffer.concat([data, Buffer.alloc(old - data.length, 0x20)]);
    await fh.write(padded, 0, padded.length, 0);
    await fh.truncate(data.length);
    await fh.chmod(0o666).catch(() => {});
  } finally {
    await fh.close();
  }
  return file;
}

/** Remove a box's per-box credential files (a failed create). Never throws. */
export async function removeBoxCredentialFiles(box: BoxDirRef): Promise<void> {
  await rm(join(boxRunDirFor(box), 'credentials'), { recursive: true, force: true }).catch(
    () => {},
  );
}

/**
 * Make the agent's credential path inside its config `volume` a regular file.
 *
 * The bake symlinks it into `~/.agentbox-creds` (the cloud credentials mount),
 * and docker copies that link into every new, empty volume. A bind mounted
 * over a symlink lands on the link's TARGET, so the agent's next save renames
 * a regular file over the link in the shared volume and never touches the
 * per-box file again. A regular file at the path is what the bind covers.
 */
export async function ensureVolumeCredentialIsFile(
  volume: string,
  image: string,
  agent: string,
): Promise<void> {
  const cred = resolveAgentSpec(agent).credential;
  if (!cred) return;
  const f = `/v/${cred.boxRelPath}`;
  const r = await execa(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      '0',
      '--entrypoint',
      'sh',
      '-v',
      `${volume}:/v`,
      image,
      '-c',
      `if [ -L '${f}' ] || [ ! -e '${f}' ]; then rm -f '${f}' && printf '{}\\n' > '${f}' && chown ${BOX_USER}:${BOX_USER} '${f}' && chmod 600 '${f}'; fi`,
    ],
    { reject: false },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `could not prepare ${agent}'s credential path in ${volume}: ${r.stderr.trim()}`,
    );
  }
}

/** Whether `agent` gets a per-box credential file (`credential.bindMountable`). */
export function hasBoxCredentialFile(agent: string): boolean {
  return resolveAgentSpec(agent).credential?.bindMountable === true;
}

/**
 * What a per-box file starts as when the account's volume holds no login (a
 * box on a setup token or API key). Claude reads `{}` as plainly logged out and
 * leaves it alone (measured), so the env token still wins and a later switch to
 * a login can write the file. Another shape has no known-safe empty value, so
 * that agent gets no per-box file and keeps the volume's.
 */
export function emptyCredentialPlaceholder(agent: string): string | null {
  return resolveAgentSpec(agent).credential?.realShape === 'claude-oauth' ? '{}\n' : null;
}
