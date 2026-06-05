/**
 * Host-side size accounting for `agentbox cp`: an exclude-aware recursive
 * `du`-style walk that powers the over-threshold guard. When a copy would
 * exceed `box.cpMaxBytes`, the command prints the heaviest folders/subfolders
 * so the caller (often an in-box agent) can decide what to drop or split.
 *
 * The walk's exclusion semantics are kept in lockstep with the tar patterns
 * `toTarExcludes` emits, so the size we report matches what actually copies.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Heavy build/VCS dirs dropped by default (override with `--no-default-excludes`).
 * These are regenerable in the box (`git`/`npm`/`dotnet restore`/rebuild) and are
 * the usual reason a workspace folder balloons past the per-copy size limit.
 */
export const DEFAULT_CP_EXCLUDES = [
  '.git',
  'node_modules',
  'bin',
  'obj',
  'packages',
  'dist',
  '.next',
  'target',
];

/** A token with no glob metachar and no `/` matches a path component by name. */
function isBareName(token: string): boolean {
  return !token.includes('/') && !token.includes('*') && !token.includes('?');
}

/**
 * Expand exclude tokens to `tar --exclude` patterns. A bare name (e.g.
 * `node_modules`) becomes `*​/node_modules` + `node_modules` so it matches at any
 * depth in the tarball (members carry the source basename prefix). Glob/path
 * tokens pass through verbatim.
 */
export function toTarExcludes(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (isBareName(t)) {
      out.push(`*/${t}`, t);
    } else {
      out.push(t);
    }
  }
  return out;
}

/** Combine the default exclude set (unless opted out) with user tokens. */
export function effectiveExcludes(userTokens: string[], useDefaults: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (t: string) => {
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  if (useDefaults) DEFAULT_CP_EXCLUDES.forEach(add);
  userTokens.forEach(add);
  return out;
}

function globToRegExp(glob: string): RegExp {
  // tar's exclude wildcards match `/` by default, so `*` -> `.*`.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** True if `relPath` (posix, relative to the copy root) is excluded. */
export function isPathExcluded(relPath: string, tokens: string[]): boolean {
  const segs = relPath.split('/');
  for (const t of tokens) {
    if (isBareName(t)) {
      if (segs.includes(t)) return true;
    } else if (globToRegExp(t).test(relPath)) {
      return true;
    }
  }
  return false;
}

export interface TreeNode {
  /** Path relative to the copy root (`'.'` for the root itself). */
  path: string;
  bytes: number;
  children: TreeNode[];
}

async function buildNode(
  abs: string,
  rel: string,
  tokens: string[],
  seen: Set<string>,
): Promise<TreeNode> {
  let bytes = 0;
  const children: TreeNode[] = [];
  let entries: string[];
  try {
    entries = await readdir(abs);
  } catch {
    return { path: rel || '.', bytes: 0, children };
  }
  for (const name of entries) {
    const childRel = rel ? `${rel}/${name}` : name;
    if (isPathExcluded(childRel, tokens)) continue;
    const full = join(abs, name);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    // Guard against symlink cycles inflating the total.
    const key = `${String(st.dev)}:${String(st.ino)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (st.isDirectory()) {
      const child = await buildNode(full, childRel, tokens, seen);
      bytes += child.bytes;
      children.push(child);
    } else if (st.isFile()) {
      bytes += st.size;
    }
  }
  return { path: rel || '.', bytes, children };
}

export interface MeasureResult {
  totalBytes: number;
  isDir: boolean;
  /** Rendered breakdown lines (biggest first, depth-limited). Empty for files. */
  treeLines: string[];
  /** Immediate subdirectories, biggest first (for split-copy suggestions). */
  topChildren: Array<{ path: string; bytes: number }>;
}

export interface MeasureOptions {
  /** Max directory depth to render (root is depth 0). Default 3. */
  maxDepth?: number;
  /** Hide folders smaller than this in the rendered tree. Default 10 MiB. */
  floorBytes?: number;
  /** Max children shown per level. Default 8. */
  perLevel?: number;
}

/**
 * Measure a copy source (file or dir) after applying exclude tokens, and render
 * a `du`-style tree of the heaviest remaining folders/subfolders.
 */
export async function measureCopy(
  absSrc: string,
  tokens: string[],
  opts: MeasureOptions = {},
): Promise<MeasureResult> {
  const st = await stat(absSrc);
  if (!st.isDirectory()) {
    return { totalBytes: st.size, isDir: false, treeLines: [], topChildren: [] };
  }
  const root = await buildNode(absSrc, '', tokens, new Set<string>());
  const maxDepth = opts.maxDepth ?? 3;
  const floor = opts.floorBytes ?? 10 * 1024 * 1024;
  const perLevel = opts.perLevel ?? 8;
  const lines: string[] = [];
  const render = (node: TreeNode, depth: number, label: string): void => {
    const pad = '  '.repeat(depth);
    lines.push(`  ${fmtBytes(node.bytes).padStart(8)}  ${pad}${label}`);
    if (depth >= maxDepth) return;
    const kids = [...node.children]
      .sort((a, b) => b.bytes - a.bytes)
      .filter((c) => c.bytes >= floor)
      .slice(0, perLevel);
    for (const kid of kids) {
      render(kid, depth + 1, `./${kid.path}`);
    }
  };
  render(root, 0, './');
  const topChildren = [...root.children]
    .sort((a, b) => b.bytes - a.bytes)
    .map((c) => ({ path: c.path, bytes: c.bytes }));
  return { totalBytes: root.bytes, isDir: true, treeLines: lines, topChildren };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
