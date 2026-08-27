import { lstat, mkdir, readdir, readlink, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Materialize one `/…/bin/<tool>` symlink per granted host tool, all pointing
 * at the single baked `agentbox-tool-shim`.
 *
 * This is what makes the feature work without an image rebake: the shim is
 * baked once, and the *set* of tools is just a set of symlinks the in-box
 * daemon keeps in sync with the host's grant list. Approving a
 * `tool request` makes the command appear in a running box.
 *
 * The links land in `~/.local/bin` rather than `/usr/local/bin` for a
 * concrete reason: the ctl daemon runs as `vscode`, not root, so it cannot
 * write `/usr/local/bin`. `~/.local/bin` is vscode-owned and is already
 * FIRST on PATH on every provider (the Dockerfile `ENV PATH` and each cloud
 * provider's `/etc/profile.d/agentbox.sh` both prepend it), so a link there
 * wins resolution against anything in `/usr/bin`.
 */

/** Where the baked multi-call shim lives in every image. */
export const TOOL_SHIM_PATH = '/usr/local/bin/agentbox-tool-shim';

export function toolLinkDir(): string {
  return join(process.env['HOME'] ?? homedir(), '.local', 'bin');
}

export interface ToolLinkSyncResult {
  added: string[];
  removed: string[];
  /** Names skipped because a real file already owns the name. */
  conflicts: string[];
}

/**
 * Make `~/.local/bin` hold exactly one shim symlink per name in `names`.
 *
 * Only touches links this function created (targets resolving to
 * `TOOL_SHIM_PATH`). A real binary sitting at the same name is reported as a
 * conflict and left alone — silently shadowing a user's own `terraform` with
 * a host proxy would be a nasty surprise, and the reverse (clobbering it)
 * would lose their install.
 */
export async function syncToolLinks(
  names: readonly string[],
  opts: { dir?: string; shim?: string } = {},
): Promise<ToolLinkSyncResult> {
  const dir = opts.dir ?? toolLinkDir();
  const shim = opts.shim ?? TOOL_SHIM_PATH;
  const wanted = new Set(names.filter((n) => VALID_NAME.test(n)));
  const result: ToolLinkSyncResult = { added: [], removed: [], conflicts: [] };

  await mkdir(dir, { recursive: true });

  // Remove links we own that are no longer granted (a revoked grant should
  // make the command stop resolving, not linger until the box restarts).
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (wanted.has(entry)) continue;
    if (await isOurLink(join(dir, entry), shim)) {
      await unlink(join(dir, entry)).catch(() => undefined);
      result.removed.push(entry);
    }
  }

  for (const name of wanted) {
    const path = join(dir, name);
    const existing = await lstat(path).catch(() => null);
    if (existing) {
      if (await isOurLink(path, shim)) continue; // already correct
      result.conflicts.push(name);
      continue;
    }
    try {
      await symlink(shim, path);
      result.added.push(name);
    } catch {
      result.conflicts.push(name);
    }
  }
  return result;
}

async function isOurLink(path: string, shim: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    if (!st.isSymbolicLink()) return false;
    return (await readlink(path)) === shim;
  } catch {
    return false;
  }
}

const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/;
