/**
 * Normalize a skill directory into a file list and its tree hash — the
 * library's version id.
 *
 * Symlinks are resolved on THIS machine, but only within the skill: a link whose
 * target lies outside the skill's own (real) root is reported in `outOfTreeLinks`
 * and not followed, so a `refs -> ~/Projects/app` link can't upload a whole
 * checkout (its `.env` included) to a hub every box reads. The skill root may
 * itself be a link (`~/.claude/skills/x -> ~/.agents/skills/x`): its target is
 * the root. A link that does not resolve is reported in `brokenLinks`. Either
 * fails the skill with its path named, instead of being dropped (a box would
 * otherwise get a skill missing a file the host sees). Modes collapse to
 * 0644/0755, so the hash is the same for the same content on every PC.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { scanSkillFiles, type SecretFinding } from './scan.js';

/** One normalized file of a skill: POSIX relative path, 0644/0755, bytes and their sha256. */
export interface SkillFile {
  path: string;
  mode: number;
  data: Buffer;
  sha256: string;
}

export interface SkillTree {
  files: SkillFile[];
  /** Total bytes of all files. */
  size: number;
  /** Newest mtime among the files (ms), for "which side is newer". */
  newestMtimeMs: number;
  /** Links that don't resolve, relative to the skill root. */
  brokenLinks: string[];
  /** Links that resolve OUTSIDE the skill's real root, relative to it; not followed. */
  outOfTreeLinks: string[];
  /** A summary read's secret-scan hits (see {@link SkillHashCache}); absent otherwise. */
  findings?: SecretFinding[];
}

/** Never part of a skill: VCS metadata and Finder droppings. */
const SKIP_NAMES = new Set(['.git', '.DS_Store']);

export class SkillTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(
      `skill is ${String(size)} bytes, over the ${String(maxBytes)}-byte cap (skills.maxSkillBytes)`,
    );
    this.name = 'SkillTooLargeError';
  }
}

/**
 * What a summary read remembers of one file, keyed by its path + size + mtime:
 * the content hash and the secret-scan hits (rule + line; the path is the file's).
 * A file rewritten with the same size and mtime (`touch -r`, `cp -p`,
 * `rsync -a`) reads as unchanged; acceptable for its one user, the drift notice.
 */
export interface SkillHashEntry {
  sha256: string;
  findings: { rule: string; line: number }[];
}

/**
 * File hashes remembered across runs. With one, a read is a summary: every
 * file's `data` is empty and only its `sha256` is filled (from the cache when
 * the file is unchanged), and the scan hits come back on the tree as
 * `findings`, so the tree hash and the upload blockers come cheap but the
 * content is not there to upload.
 */
export interface SkillHashCache {
  get(path: string, size: number, mtimeMs: number): SkillHashEntry | undefined;
  set(path: string, size: number, mtimeMs: number, entry: SkillHashEntry): void;
}

const EMPTY = Buffer.alloc(0);

export async function readSkillTree(
  root: string,
  opts: { maxBytes?: number; hashCache?: SkillHashCache } = {},
): Promise<SkillTree> {
  const files: SkillFile[] = [];
  const brokenLinks: string[] = [];
  const outOfTreeLinks: string[] = [];
  const rootReal = await realpath(root);
  const inTree = (p: string): boolean => p === rootReal || p.startsWith(rootReal + sep);
  let size = 0;
  let newestMtimeMs = 0;
  const summaryFindings: SecretFinding[] = [];
  // The real directories on the CURRENT path only: a link back to an ancestor is
  // a cycle and stops, while two links to the same shared directory are both
  // walked, because the host agent reads the content under both names.
  async function walk(abs: string, rel: string, ancestors: ReadonlySet<string>): Promise<void> {
    const real = await realpath(abs);
    if (ancestors.has(real)) return;
    const chain = new Set(ancestors).add(real);
    const names = (await readdir(abs)).sort();
    for (const name of names) {
      if (SKIP_NAMES.has(name)) continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const l = await lstat(childAbs);
      let st = l;
      if (l.isSymbolicLink()) {
        try {
          st = await stat(childAbs);
        } catch {
          brokenLinks.push(childRel);
          continue;
        }
        if (!inTree(await realpath(childAbs))) {
          outOfTreeLinks.push(childRel);
          continue;
        }
      }
      if (st.isDirectory()) {
        await walk(childAbs, childRel, chain);
      } else if (st.isFile()) {
        size += st.size;
        if (opts.maxBytes !== undefined && size > opts.maxBytes) {
          throw new SkillTooLargeError(size, opts.maxBytes);
        }
        newestMtimeMs = Math.max(newestMtimeMs, st.mtimeMs);
        const mode = (st.mode & 0o111) !== 0 ? 0o755 : 0o644;
        const cache = opts.hashCache;
        if (cache) {
          // The walked path, not its realpath: size + mtime already prove a hit.
          const key = childAbs;
          let entry = cache.get(key, st.size, st.mtimeMs);
          if (entry === undefined) {
            const data = await readFile(childAbs);
            entry = {
              sha256: createHash('sha256').update(data).digest('hex'),
              findings: scanSkillFiles([{ path: childRel, data }]).map((f) => ({
                rule: f.rule,
                line: f.line,
              })),
            };
          }
          cache.set(key, st.size, st.mtimeMs, entry);
          for (const f of entry.findings) summaryFindings.push({ ...f, path: childRel });
          files.push({ path: childRel, mode, data: EMPTY, sha256: entry.sha256 });
          continue;
        }
        const data = await readFile(childAbs);
        files.push({
          path: childRel,
          mode: (st.mode & 0o111) !== 0 ? 0o755 : 0o644,
          data,
          sha256: createHash('sha256').update(data).digest('hex'),
        });
      }
      // Sockets, FIFOs, devices: not skill content, skipped.
    }
  }

  await walk(root, '', new Set());
  return {
    files,
    size,
    newestMtimeMs,
    brokenLinks,
    outOfTreeLinks,
    ...(opts.hashCache ? { findings: summaryFindings } : {}),
  };
}

/**
 * The version id: sha256 over `<mode> <sha256> <path>\n` lines sorted by
 * path (JS string order). Content and executable bit only — no mtimes, owners or tar framing.
 */
export function treeHash(
  files: readonly { path: string; mode: number; sha256?: string; data?: Buffer }[],
): string {
  const lines = files
    .map((f) => {
      const sha =
        f.sha256 ??
        createHash('sha256')
          .update(f.data ?? Buffer.alloc(0))
          .digest('hex');
      return { path: f.path, line: `${f.mode.toString(8)} ${sha} ${f.path}\n` };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  for (const l of lines) h.update(l.line);
  return h.digest('hex');
}
