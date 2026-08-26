/**
 * Filesystem-backed {@link CustodyStore} — phase 2's backend: plain files under
 * `~/.agentbox/hub/custody/`, `0700` dirs / `0600` files. No sidecar manifest:
 * digests are computed from the bytes on read, so the manifest can never drift
 * from what is actually stored.
 *
 * `put`/`get` read the whole value into memory, which is right for what custody
 * was built to hold (credentials / `.env` / SSH keys — kilobytes). A project's
 * `carry:` material is the exception, so `putStream`/`getStream` pipe instead;
 * see the seam docs on {@link CustodyStore.putStream}.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { STATE_DIR } from '@agentbox/config';
import {
  custodyDigest,
  CustodyTooLargeError,
  normalizeCustodyPath,
  normalizeCustodyPrefix,
  type CustodyEntry,
  type CustodyPutResult,
  type CustodyStore,
} from './store.js';

/** Where the control box keeps custody — sibling of `store.db` / `auth.db`. */
export const DEFAULT_CUSTODY_DIR = join(STATE_DIR, 'hub', 'custody');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface FsCustodyStoreOptions {
  /** Custody root. Defaults to {@link DEFAULT_CUSTODY_DIR}. */
  root?: string;
}

export class FsCustodyStore implements CustodyStore {
  readonly root: string;

  constructor(opts: FsCustodyStoreOptions = {}) {
    this.root = opts.root ?? DEFAULT_CUSTODY_DIR;
  }

  async put(path: string, data: Buffer): Promise<CustodyPutResult> {
    const rel = normalizeCustodyPath(path);
    const abs = join(this.root, rel);
    const sha256 = custodyDigest(data);

    const existing = await this.readEntry(rel);
    if (existing && existing.entry.sha256 === sha256) {
      // Content-addressed skip: identical bytes are already stored, so the file
      // (and its mtime) is left untouched — an unchanged re-push is a no-op.
      return { ...existing.entry, changed: false };
    }

    await mkdir(dirname(abs), { recursive: true, mode: DIR_MODE });
    // Atomic: a reader (or a crash) never observes a half-written credential.
    const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, data, { mode: FILE_MODE });
      await chmod(tmp, FILE_MODE);
      await rename(tmp, abs);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    const st = await stat(abs);
    return {
      path: rel,
      size: data.length,
      sha256,
      mode: st.mode & 0o777,
      updatedAt: st.mtime.toISOString(),
      changed: true,
    };
  }

  async get(path: string): Promise<{ entry: CustodyEntry; data: Buffer } | null> {
    return this.readEntry(normalizeCustodyPath(path));
  }

  async stat(path: string): Promise<CustodyEntry | null> {
    const found = await this.readEntry(normalizeCustodyPath(path));
    return found ? found.entry : null;
  }

  async list(prefix?: string): Promise<CustodyEntry[]> {
    const rel = prefix === undefined ? '' : normalizeCustodyPrefix(prefix);
    const entries: CustodyEntry[] = [];
    for (const found of await this.walk(this.root)) {
      // Prefix match on path segments — `agents/cl` must not match `agents/claude`.
      if (rel.length > 0 && found !== rel && !found.startsWith(`${rel}/`)) continue;
      const e = await this.readEntry(found);
      if (e) entries.push(e.entry);
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  }

  async delete(path: string): Promise<boolean> {
    const rel = normalizeCustodyPath(path);
    const abs = join(this.root, rel);
    try {
      await rm(abs);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async putStream(
    path: string,
    body: Readable,
    opts: { maxBytes?: number } = {},
  ): Promise<CustodyPutResult> {
    const rel = normalizeCustodyPath(path);
    const abs = join(this.root, rel);
    await mkdir(dirname(abs), { recursive: true, mode: DIR_MODE });
    const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;

    const hash = createHash('sha256');
    let size = 0;
    // Cap while streaming, not after: the point of this path is never to hold
    // the whole payload, so an over-cap body must be cut off mid-flight rather
    // than measured once it has already landed.
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (opts.maxBytes !== undefined && size > opts.maxBytes) {
          cb(new CustodyTooLargeError(opts.maxBytes));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    try {
      await pipeline(body, meter, createWriteStream(tmp, { mode: FILE_MODE }));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }

    const sha256 = hash.digest('hex');
    const existing = await this.readEntryMeta(rel);
    if (existing && existing.sha256 === sha256) {
      // Same content-addressed skip `put` makes. The bytes still crossed the
      // wire (a stream can't be hashed before it arrives), but the stored file
      // and its mtime are left alone — the client's manifest pre-check is what
      // avoids the transfer itself.
      await rm(tmp, { force: true });
      return { ...existing, changed: false };
    }

    try {
      await chmod(tmp, FILE_MODE);
      await rename(tmp, abs);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    const st = await stat(abs);
    return {
      path: rel,
      size,
      sha256,
      mode: st.mode & 0o777,
      updatedAt: st.mtime.toISOString(),
      changed: true,
    };
  }

  async getStream(path: string): Promise<{ entry: CustodyEntry; data: Readable } | null> {
    const rel = normalizeCustodyPath(path);
    const entry = await this.readEntryMeta(rel);
    if (!entry) return null;
    return { entry, data: createReadStream(join(this.root, rel)) };
  }

  /**
   * Metadata without holding the value. Digest still comes from the bytes (no
   * sidecar to drift), but they are hashed in a streaming pass and discarded,
   * so a 100 MiB entry costs a buffer's worth of memory rather than 100 MiB.
   */
  private async readEntryMeta(rel: string): Promise<CustodyEntry | null> {
    const abs = join(this.root, rel);
    try {
      const st = await stat(abs);
      if (!st.isFile()) return null;
      const hash = createHash('sha256');
      await pipeline(
        createReadStream(abs),
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            cb();
          },
        }),
      );
      return {
        path: rel,
        size: st.size,
        sha256: hash.digest('hex'),
        mode: st.mode & 0o777,
        updatedAt: st.mtime.toISOString(),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async readEntry(rel: string): Promise<{ entry: CustodyEntry; data: Buffer } | null> {
    const abs = join(this.root, rel);
    try {
      const [data, st] = await Promise.all([readFile(abs), stat(abs)]);
      return {
        entry: {
          path: rel,
          size: data.length,
          sha256: custodyDigest(data),
          mode: st.mode & 0o777,
          updatedAt: st.mtime.toISOString(),
        },
        data,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') return null;
      throw err;
    }
  }

  /** Custody-relative paths of every regular file under `dir` (tmp files skipped). */
  private async walk(dir: string): Promise<string[]> {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: string[] = [];
    for (const d of dirents) {
      const abs = join(dir, d.name);
      if (d.isDirectory()) {
        out.push(...(await this.walk(abs)));
      } else if (d.isFile() && !d.name.endsWith('.tmp')) {
        out.push(relative(this.root, abs).split(sep).join('/'));
      }
    }
    return out;
  }
}
