/**
 * Host-side symlink pre-scan shared by the skills/agents-volume seed and the
 * claude static stage. Pure filesystem inspection (no docker, no box), so it
 * lives in the sync layer and both providers reuse it. Moved here from
 * `@agentbox/sandbox-docker`'s `claude.ts`, which re-exports it for its existing
 * importers.
 */

import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Walk `root` and return rsync-style relative paths of every symlink the
 * in-container sync can't dereference, so we can `--exclude` them. Two cases
 * abort the whole sync under `--copy-unsafe-links` if left in:
 *
 *  - Broken on the host (e.g. claude's `debug/latest` once an older debug file
 *    is reaped).
 *  - Valid on the host but pointing OUTSIDE the trees the helper container
 *    mounts (`reachableRoots`: `~/.claude` itself and, when present, `~/.agents`
 *    at `/.agents`). The referent then has "no referent" inside the box — e.g. a
 *    dev's `~/.claude/skills/*` symlinked into an agentbox source checkout.
 *
 * A symlinked directory whose target IS reachable can still hide an unsyncable
 * link one level down: `~/.claude/skills/<name>` -> `~/.agents/skills/<name>`
 * (reachable) whose `SKILL.md` is an ABSOLUTE link into a repo checkout (not
 * mounted). rsync's `--copy-unsafe-links` dereferences the reachable dir link
 * and descends into it, then aborts on the nested absolute link. So when a
 * symlink resolves into a reachable tree we recurse into the resolved target,
 * reporting nested findings under the symlink's path as rsync transfers it
 * (the link name in `root`, not the resolved `~/.agents` path). An ancestry
 * guard (`onPath`) blocks symlink cycles without suppressing the same resolved
 * dir reached under a *different* virtual prefix — e.g. two skills symlinked to
 * one shared target must each report their nested unsyncable link, or rsync
 * still aborts on the prefix we skipped.
 */
export async function findUnsyncableSymlinks(
  root: string,
  reachableRoots: string[],
): Promise<string[]> {
  // realpath the reachable roots so a symlinked ancestor (e.g. macOS
  // /var -> /private/var) doesn't make a containment check spuriously fail.
  const reachable = await Promise.all(
    reachableRoots.map(async (r) => {
      try {
        return await realpath(r);
      } catch {
        return r;
      }
    }),
  );
  const unsyncable: string[] = [];
  // Resolved dirs currently on the recursion path. Guards against symlink
  // cycles (a link pointing at an ancestor) while still allowing the same dir
  // to be re-walked under a different virtual prefix once this branch unwinds.
  const onPath = new Set<string>();
  // `realDir` is the filesystem directory to read; `virtualDir` is its path as
  // rsync sees it under `root` (they diverge once we follow a symlinked dir).
  async function walk(realDir: string, virtualDir: string): Promise<void> {
    if (onPath.has(realDir)) return;
    onPath.add(realDir);
    try {
      let entries;
      try {
        entries = await readdir(realDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const realFull = join(realDir, ent.name);
        const virtualFull = virtualDir ? join(virtualDir, ent.name) : ent.name;
        if (ent.isSymbolicLink()) {
          let real: string;
          try {
            real = await realpath(realFull);
          } catch {
            unsyncable.push(virtualFull); // broken on the host
            continue;
          }
          if (!reachable.some((r) => isUnder(r, real))) {
            unsyncable.push(virtualFull); // target not mounted in the box
            continue;
          }
          // Reachable target: rsync will dereference + descend, so check inside
          // it too for nested unsyncable links, keyed to the symlink's path.
          const st = await stat(real).catch(() => null);
          if (st?.isDirectory()) await walk(real, virtualFull);
        } else if (ent.isDirectory()) {
          await walk(realFull, virtualFull);
        }
      }
    } finally {
      onPath.delete(realDir);
    }
  }
  await walk(root, '');
  return unsyncable;
}
