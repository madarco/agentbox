import { execa } from 'execa';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { sanitizeMnemonic } from '@agentbox/config';

/**
 * Directories whose contents are either platform-specific (built native modules,
 * compiled outputs) or large enough to be wasteful to include in a frozen
 * workspace snapshot. Pruned from the snapshot tree *after* the APFS clone
 * — removing CoW-cloned entries is essentially free.
 */
export const EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.next',
  '.nuxt',
  '.turbo',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  '__pycache__',
  '.cache',
  '.parcel-cache',
]);

export const SNAPSHOTS_ROOT = join(homedir(), '.agentbox', 'snapshots');

/**
 * `<id>-<n>-<mnemonic>` when `projectIndex` is set (post-feature boxes — all
 * new boxes), else `<id>-<mnemonic>` (legacy pre-feature fallback). Mirrors
 * `boxDirSegment` in `host-export.ts` — kept structurally compatible so the
 * snapshot dir can be looked up alongside its box dir.
 */
export function snapshotPathFor(box: { id: string; name: string; projectIndex?: number }): string {
  const mnemonic = sanitizeMnemonic(box.name);
  const n = box.projectIndex;
  const segment =
    typeof n === 'number' && Number.isFinite(n) && n > 0
      ? `${box.id}-${String(n)}-${mnemonic}`
      : `${box.id}-${mnemonic}`;
  return join(SNAPSHOTS_ROOT, segment);
}

/**
 * Walk a directory tree and return absolute paths of every directory whose
 * basename matches `EXCLUDE_DIRS`. Does not descend into a matched directory.
 * Pure (modulo `fs.readdir`) — easy to unit-test against a fixture tree.
 */
export async function findExcludedDirs(
  root: string,
  excluded: ReadonlySet<string> = EXCLUDE_DIRS,
): Promise<string[]> {
  const matches: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const abs = join(dir, entry.name);
      if (excluded.has(entry.name)) {
        matches.push(abs);
        continue; // do not descend
      }
      await walk(abs);
    }
  };
  await walk(root);
  return matches;
}

export interface CreateSnapshotOptions {
  source: string;
  destination: string;
  excluded?: ReadonlySet<string>;
}

export interface CreateSnapshotResult {
  destination: string;
  prunedPaths: string[];
}

/**
 * Create a frozen workspace snapshot. On macOS (APFS) this is an instant CoW
 * clone via `cp -cR`; on other platforms it falls back to plain `cp -R`
 * (slow, but functional — the production fallback will be `rsync --exclude`).
 *
 * After the copy, prune all `EXCLUDE_DIRS` directories so the snapshot is free
 * of platform-specific artifacts before it becomes the overlay's lower layer.
 */
export async function createSnapshot(opts: CreateSnapshotOptions): Promise<CreateSnapshotResult> {
  const source = resolve(opts.source);
  const destination = resolve(opts.destination);
  const excluded = opts.excluded ?? EXCLUDE_DIRS;

  await mkdir(SNAPSHOTS_ROOT, { recursive: true });

  // `cp -c` only exists on macOS and is the APFS clone flag.
  const cpArgs = platform() === 'darwin' ? ['-cR'] : ['-R'];
  await execa('cp', [...cpArgs, `${source}/`, destination]);

  const toPrune = await findExcludedDirs(destination, excluded);
  await Promise.all(toPrune.map((p) => rm(p, { recursive: true, force: true })));

  return { destination, prunedPaths: toPrune };
}

/** Guard used by tests + by `create.ts` when we don't want to clobber a path. */
export async function snapshotExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
