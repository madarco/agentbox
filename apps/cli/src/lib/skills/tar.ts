/**
 * A minimal tar writer + reader for skill tarballs.
 *
 * Why not the system `tar`: the two ends of a skill transfer are PCs, and a
 * Mac's bsdtar and Linux's GNU tar disagree on the flags that matter here
 * (dereference, deterministic metadata), while the READ side has to refuse
 * symlinks, hard links and `..` paths before anything touches the disk — which
 * a system `tar -x` does differently per platform and version. Skill trees are
 * small (capped by `skills.maxSkillBytes`), regular files only, so a ustar
 * writer with pax long-path records and a reader that accepts exactly that
 * subset is ~150 lines and behaves identically everywhere.
 *
 * Output is deterministic (sorted paths, mtime/uid/gid 0, no owner names), so the
 * same tree yields the same bytes on every PC.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

export interface TarFile {
  /** POSIX relative path, no leading `/`, no `..`. */
  path: string;
  /** 0o644 or 0o755. */
  mode: number;
  data: Buffer;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  // width includes the trailing NUL.
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, mode: number, size: number, type: string): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

function padded(data: Buffer): Buffer[] {
  const rem = data.length % BLOCK;
  return rem === 0 ? [data] : [data, Buffer.alloc(BLOCK - rem, 0)];
}

/** One pax record: `<len> <key>=<value>\n`, where `<len>` counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len++;
  return `${String(len)}${body}`;
}

/** Gzipped tar of `files`, sorted by path. */
export function writeTar(files: readonly TarFile[]): Buffer {
  const parts: Buffer[] = [];
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of sorted) {
    assertSafePath(f.path);
    let name = f.path;
    if (Buffer.byteLength(f.path) > 99) {
      const pax = Buffer.from(paxRecord('path', f.path), 'utf8');
      parts.push(header('PaxHeader', 0o644, pax.length, 'x'), ...padded(pax));
      name = f.path.slice(0, 99);
    }
    parts.push(header(name, f.mode, f.data.length, '0'), ...padded(f.data));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export class SkillTarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillTarError';
  }
}

export function assertSafePath(p: string): void {
  if (
    p.length === 0 ||
    p.startsWith('/') ||
    p.includes('\\') ||
    p.includes('\0') ||
    p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  ) {
    throw new SkillTarError(`unsafe path in skill tarball: '${p}'`);
  }
}

function field(h: Buffer, off: number, len: number): string {
  const raw = h.subarray(off, off + len);
  const nul = raw.indexOf(0);
  return (nul === -1 ? raw : raw.subarray(0, nul)).toString('utf8');
}

function num(h: Buffer, off: number, len: number): number {
  const s = field(h, off, len).trim();
  if (s.length === 0) return 0;
  if (!/^[0-7]+$/.test(s)) throw new SkillTarError('malformed numeric field in tar header');
  return parseInt(s, 8);
}

function checksumOk(h: Buffer): boolean {
  const stored = num(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === stored;
}

/**
 * Parse a gzipped tar into regular files. Directories are skipped; any other
 * entry type (symlink, hard link, device, …) or an unsafe path is an error, so a
 * hostile tarball is refused before a single byte is written.
 */
export function readTar(gz: Buffer, opts: { maxBytes?: number } = {}): TarFile[] {
  let buf: Buffer;
  try {
    // `maxBytes` caps the skill's CONTENT; the tar framing (a 512-byte header plus
    // padding per file, more with pax records) comes on top and grows with the
    // file count. The output cap is a decompression-bomb guard, not the content
    // cap, so it leaves generous room; content is checked after parsing.
    buf = gunzipSync(
      gz,
      opts.maxBytes !== undefined ? { maxOutputLength: opts.maxBytes * 2 + 16 * 1024 * 1024 } : {},
    );
  } catch (err) {
    throw new SkillTarError(
      `not a gzip tarball: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const out: TarFile[] = [];
  let pendingPath: string | undefined;
  let contentBytes = 0;
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) throw new SkillTarError('tar header checksum mismatch');
    const type = String.fromCharCode(h[156]!) || '0';
    const size = num(h, 124, 12);
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new SkillTarError('truncated tarball');
    const data = buf.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      for (const rec of data.toString('utf8').split('\n')) {
        const m = /^\d+ path=(.*)$/.exec(rec);
        if (m) pendingPath = m[1];
      }
      continue;
    }
    if (type === 'g') continue;
    const prefix = field(h, 345, 155);
    const name = pendingPath ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    pendingPath = undefined;
    if (type === '5') continue;
    if (type !== '0' && type !== '\0') {
      throw new SkillTarError(
        `skill tarball holds a non-regular entry ('${name}', type '${type}')`,
      );
    }
    const path = name.replace(/^\.\//, '');
    assertSafePath(path);
    const mode = (num(h, 100, 8) & 0o111) !== 0 ? 0o755 : 0o644;
    out.push({ path, mode, data: Buffer.from(data) });
    contentBytes += size;
    if (opts.maxBytes !== undefined && contentBytes > opts.maxBytes) {
      throw new SkillTarError(`skill tarball holds more than ${String(opts.maxBytes)} bytes`);
    }
  }
  return out;
}
