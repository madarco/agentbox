import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type { CarryItem } from '@agentbox/ctl';

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
  optional: boolean;
  symlinkInfo?: 'safe' | 'outside-home';
}

export interface ResolveOptions {
  /** Absolute path to the dir holding `agentbox.yaml`. `./` srcs anchor here. */
  projectRoot: string;
  /** Resolved $HOME for the user. Injected so tests can stub it. */
  homeDir?: string;
  /** Per-entry size cap in bytes; env override AGENTBOX_CARRY_MAX_BYTES. Default 50 MiB. */
  maxBytes?: number;
}

export interface ResolveResult {
  entries: ResolvedCarryEntry[];
  errors: string[];
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

const DENYLIST_DEST_PREFIXES = ['/proc', '/sys', '/dev'];
const DENYLIST_DEST_EXACT = new Set(['/etc/passwd', '/etc/shadow']);

export async function resolveCarry(
  items: CarryItem[],
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const home = opts.homeDir ?? homedir();
  const cap = opts.maxBytes ?? readMaxBytesFromEnv() ?? DEFAULT_MAX_BYTES;
  const projectRoot = opts.projectRoot;

  const entries: ResolvedCarryEntry[] = [];
  const errors: string[] = [];

  for (const [i, item] of items.entries()) {
    const where = `carry[${String(i)}]`;
    try {
      const entry = await resolveOne(item, { projectRoot, home, cap, where });
      entries.push(entry);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { entries, errors };
}

function readMaxBytesFromEnv(): number | undefined {
  const raw = process.env.AGENTBOX_CARRY_MAX_BYTES;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

interface OneCtx {
  projectRoot: string;
  home: string;
  cap: number;
  where: string;
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

  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(absSrc);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (optional) {
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
    const bytes = await dirSizeCapped(absSrc, ctx.cap);
    if (bytes > ctx.cap) {
      throw new Error(
        `${ctx.where}: dir "${absSrc}" exceeds ${String(ctx.cap)} bytes (set AGENTBOX_CARRY_MAX_BYTES to raise the cap or narrow the path)`,
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
      optional,
      ...(symlinkInfo ? { symlinkInfo } : {}),
    };
  }

  if (st.isFile()) {
    if (st.size > ctx.cap) {
      throw new Error(
        `${ctx.where}: file "${absSrc}" is ${String(st.size)} bytes, exceeds cap ${String(ctx.cap)} (set AGENTBOX_CARRY_MAX_BYTES to raise)`,
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

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  if (c === p) return true;
  return c.startsWith(p + '/');
}

async function realpathSafe(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

async function dirSizeCapped(dir: string, cap: number): Promise<number> {
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
