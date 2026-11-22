import { realpath } from 'node:fs/promises';
import { execa } from 'execa';
import { repoKeyAtEdge } from './project-slug.js';

/**
 * The checkouts-registry rows for folders on THIS machine: realpath'd, keyed
 * by the repo key of each folder's `origin` with this machine's ssh aliases
 * expanded. A folder with no remote yields no row. One implementation, so the
 * CLI's report and the hub's own-disk records produce identical rows.
 */
export async function checkoutEntriesFor(
  folders: readonly string[],
): Promise<{ repoKey: string; folder: string }[]> {
  const out: { repoKey: string; folder: string }[] = [];
  for (const raw of folders) {
    const folder = await realpath(raw).catch(() => raw);
    const r = await execa('git', ['-C', folder, 'remote', 'get-url', 'origin'], {
      reject: false,
    }).catch(() => null);
    const origin = r && r.exitCode === 0 ? (r.stdout ?? '').trim() : '';
    const key = await repoKeyAtEdge(origin || undefined);
    if (key && !out.some((e) => e.repoKey === key && e.folder === folder)) {
      out.push({ repoKey: key, folder });
    }
  }
  return out;
}
