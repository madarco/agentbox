import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { BUILT_IN_DEFAULTS } from '@agentbox/config';
import { isInside, realpathSafe } from '@agentbox/core';
import { resolveRuleRefs, type CarryItem, type ReplaceRule } from '@agentbox/ctl';
import { effectiveExcludes, isPathExcluded, toTarExcludes } from './dir-breakdown.js';

/**
 * One fully resolved carry entry, ready for the prompt and the per-provider
 * copy step. `rawSrc` / `rawDest` preserve what the user typed (for the prompt
 * to display); `absSrc` is the host-resolved path, `absDest` is the box-side
 * path with `~/` left intact (expanded inside the container at execute time
 * against the in-box `$HOME`).
 */
export interface ResolvedCarryEntry {
  rawSrc: string;
  rawDest: string;
  absSrc: string;
  absDest: string;
  kind: 'file' | 'dir' | 'missing';
  bytes?: number;
  mode?: number;
  /**
   * Numeric uid that should own the carried file inside the box. Mirrors
   * the field on `@agentbox/core`'s `ResolvedCarryEntry`. `resolveOne()`
   * below already forwards `item.user` into the result; this field made
   * the contract explicit so `carry-prompt.ts` can render the flag.
   */
  user?: number;
  optional: boolean;
  symlinkInfo?: 'safe' | 'outside-home';
  /** tar `--exclude` patterns applied when packing a dir entry. */
  exclude?: string[];
  /** Substitute `{{AGENTBOX_*}}` placeholders host-side before copy (file only). */
  replaceEnvs?: boolean;
  /** Final replacement rules (named refs already expanded). File only. */
  replace?: ReplaceRule[];
}

export interface ResolveOptions {
  /** Absolute path to the dir holding `agentbox.yaml`. `./` srcs anchor here. */
  projectRoot: string;
  /** Resolved $HOME for the user. Injected so tests can stub it. */
  homeDir?: string;
  /**
   * Per-entry size cap in bytes (after excludes). Callers pass the effective
   * `box.cpMaxBytes` so carry and `agentbox cp` share one limit; defaults to the
   * built-in `box.cpMaxBytes` when omitted.
   */
  maxBytes?: number;
  /** Top-level `replacements:` rule-sets, for expanding carry `rules:` refs. */
  replacements?: Record<string, ReplaceRule[]>;
}

export interface ResolveResult {
  entries: ResolvedCarryEntry[];
  errors: string[];
}

const DENYLIST_DEST_PREFIXES = ['/proc', '/sys', '/dev'];
const DENYLIST_DEST_EXACT = new Set(['/etc/passwd', '/etc/shadow']);

export async function resolveCarry(
  items: CarryItem[],
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const home = opts.homeDir ?? homedir();
  const cap = opts.maxBytes ?? BUILT_IN_DEFAULTS.box.cpMaxBytes;
  const projectRoot = opts.projectRoot;
  const replacements = opts.replacements ?? {};

  const entries: ResolvedCarryEntry[] = [];
  const errors: string[] = [];

  for (const [i, item] of items.entries()) {
    const where = `carry[${String(i)}]`;
    try {
      const entry = await resolveOne(item, { projectRoot, home, cap, where, replacements });
      entries.push(entry);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { entries, errors };
}

interface OneCtx {
  projectRoot: string;
  home: string;
  cap: number;
  where: string;
  replacements: Record<string, ReplaceRule[]>;
}

async function resolveOne(item: CarryItem, ctx: OneCtx): Promise<ResolvedCarryEntry> {
  const absSrc = expandHostPath(item.src, ctx);
  if (containsDotDot(absSrc)) {
    throw new Error(`${ctx.where}: resolved src "${absSrc}" contains .. — refused`);
  }

  validateBoxDest(item.dest, ctx);

  const optional = item.optional;
  const rawSrc = item.src;
  const rawDest = item.dest;
  const absDest = item.dest;

  // Expand named rule-set refs + inline rules into a single ordered list.
  const hasReplaceOpts = !!(item.replaceEnvs || item.replace || item.rules);
  const replaceRules: ReplaceRule[] = [
    ...resolveRuleRefs(item.rules ?? [], ctx.replacements, `${ctx.where}.rules`),
    ...(item.replace ?? []),
  ];
  const replaceFields = {
    ...(item.replaceEnvs ? { replaceEnvs: true } : {}),
    ...(replaceRules.length > 0 ? { replace: replaceRules } : {}),
  };

  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(absSrc);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (optional) {
        // A missing optional entry is skipped at transfer time, so replace
        // options are moot — don't carry them onto the tombstone.
        return {
          rawSrc,
          rawDest,
          absSrc,
          absDest,
          kind: 'missing',
          ...(item.mode !== undefined ? { mode: item.mode } : {}),
          ...(item.user !== undefined ? { user: item.user } : {}),
          optional: true,
        };
      }
      throw new Error(`${ctx.where}: host src "${absSrc}" does not exist (use optional: true to skip)`);
    }
    throw err;
  }

  // Symlink containment: a symlink whose target leaves both $HOME and
  // projectRoot is suspicious. Mark, don't reject — the prompt makes it loud.
  // Containment is computed in canonicalized space because macOS's /var
  // symlink to /private/var would otherwise make every tmpdir-rooted symlink
  // look "outside" its own project root.
  let symlinkInfo: 'safe' | 'outside-home' | undefined;
  try {
    const real = await realpath(absSrc);
    if (real !== absSrc) {
      const homeReal = await realpathSafe(ctx.home);
      const rootReal = await realpathSafe(ctx.projectRoot);
      if (!isInside(real, homeReal) && !isInside(real, rootReal)) {
        symlinkInfo = 'outside-home';
      } else {
        symlinkInfo = 'safe';
      }
    }
  } catch {
    /* best-effort; missing realpath shouldn't block carry */
  }

  if (st.isDirectory()) {
    if (hasReplaceOpts) {
      throw new Error(
        `${ctx.where}: replaceEnvs/replace/rules are file-only (src "${absSrc}" is a directory)`,
      );
    }
    // Default heavy-dir excludes + the entry's own patterns, applied to both
    // the size accounting and the copy step so the cap weighs only what lands.
    const tokens = effectiveExcludes(item.exclude ?? [], true);
    const tarPatterns = toTarExcludes(tokens);
    const bytes = await dirSizeCapped(absSrc, ctx.cap, tokens);
    if (bytes > ctx.cap) {
      throw new Error(
        `${ctx.where}: dir "${absSrc}" exceeds ${String(ctx.cap)} bytes after excludes (add carry exclude: patterns, raise box.cpMaxBytes, or narrow the path)`,
      );
    }
    return {
      rawSrc,
      rawDest,
      absSrc,
      absDest,
      kind: 'dir',
      bytes,
      ...(item.mode !== undefined ? { mode: item.mode } : {}),
      ...(item.user !== undefined ? { user: item.user } : {}),
      ...(tarPatterns.length > 0 ? { exclude: tarPatterns } : {}),
      optional,
      ...(symlinkInfo ? { symlinkInfo } : {}),
    };
  }

  if (st.isFile()) {
    if (st.size > ctx.cap) {
      throw new Error(
        `${ctx.where}: file "${absSrc}" is ${String(st.size)} bytes, exceeds cap ${String(ctx.cap)} (raise box.cpMaxBytes)`,
      );
    }
    return {
      rawSrc,
      rawDest,
      absSrc,
      absDest,
      kind: 'file',
      bytes: st.size,
      ...(item.mode !== undefined ? { mode: item.mode } : {}),
      ...(item.user !== undefined ? { user: item.user } : {}),
      optional,
      ...(symlinkInfo ? { symlinkInfo } : {}),
      ...replaceFields,
    };
  }

  throw new Error(`${ctx.where}: src "${absSrc}" is neither a regular file nor a directory`);
}

function expandHostPath(src: string, ctx: OneCtx): string {
  if (src.startsWith('~/')) {
    return resolve(ctx.home, src.slice(2));
  }
  if (src.startsWith('./')) {
    return resolve(ctx.projectRoot, src.slice(2));
  }
  if (isAbsolute(src)) return resolve(src);
  // Schema rejects this shape, but defensive anyway.
  throw new Error(`${ctx.where}: src "${src}" must start with /, ~/, or ./`);
}

function containsDotDot(p: string): boolean {
  // After normalize, any `..` segment that survived is suspicious.
  const segs = normalize(p).split('/');
  return segs.some((s) => s === '..');
}

function validateBoxDest(dest: string, ctx: OneCtx): void {
  if (dest.length === 0) {
    throw new Error(`${ctx.where}.dest must not be empty`);
  }
  if (!dest.startsWith('/') && !dest.startsWith('~/')) {
    throw new Error(`${ctx.where}.dest "${dest}" must start with / or ~/`);
  }
  // Check the RAW path for `..` segments — must not normalize first because
  // normalize() collapses `a/../b` to `b`, hiding the traversal attempt.
  const rawTail = dest.startsWith('~/') ? dest.slice(2) : dest.slice(1);
  if (rawTail.split('/').some((s) => s === '..')) {
    throw new Error(`${ctx.where}.dest "${dest}" contains .. — refused`);
  }
  if (DENYLIST_DEST_EXACT.has(dest)) {
    throw new Error(`${ctx.where}.dest "${dest}" is on the denylist`);
  }
  for (const p of DENYLIST_DEST_PREFIXES) {
    if (dest === p || dest.startsWith(`${p}/`)) {
      throw new Error(`${ctx.where}.dest "${dest}" is on the denylist (prefix ${p})`);
    }
  }
}

async function dirSizeCapped(dir: string, cap: number, exclude: string[] = []): Promise<number> {
  let total = 0;
  const seen = new Set<string>();
  async function walk(d: string): Promise<void> {
    if (total > cap) return;
    const { readdir } = await import('node:fs/promises');
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (total > cap) return;
      const full = join(d, name);
      // Skip excluded paths so the cap weighs only what actually copies. The
      // relpath is computed against the carry root with posix separators.
      const rel = relative(dir, full).split(/[\\/]/).join('/');
      if (exclude.length > 0 && isPathExcluded(rel, exclude)) continue;
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      // Loop guard for symlink cycles via the symlink-resolved inode pair.
      const key = `${String(st.dev)}:${String(st.ino)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile()) {
        total += st.size;
        if (total > cap) return;
      }
    }
  }
  await walk(dir);
  return total;
}
