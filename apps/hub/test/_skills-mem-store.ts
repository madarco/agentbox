import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { SkillsStore, SkillsStoreEntry } from '../lib/backend/skills';

/** In-memory stand-in for the custody store, with the same segment-prefix listing. */
export function memStore(): SkillsStore & { paths(): string[] } {
  const m = new Map<string, { data: Buffer; updatedAt: string }>();
  const entry = (path: string): SkillsStoreEntry => {
    const v = m.get(path)!;
    return {
      path,
      size: v.data.length,
      sha256: createHash('sha256').update(v.data).digest('hex'),
      updatedAt: v.updatedAt,
    };
  };
  const put = (path: string, data: Buffer) => {
    const before = m.get(path);
    const changed = !before || !before.data.equals(data);
    if (changed) m.set(path, { data, updatedAt: new Date().toISOString() });
    return { ...entry(path), changed };
  };
  return {
    paths: () => [...m.keys()].sort(),
    list: (prefix) =>
      Promise.resolve(
        [...m.keys()]
          .filter((p) => !prefix || p === prefix || p.startsWith(`${prefix}/`))
          .sort()
          .map(entry),
      ),
    get: (path) =>
      Promise.resolve(m.has(path) ? { entry: entry(path), data: m.get(path)!.data } : null),
    put: (path, data) => Promise.resolve(put(path, data)),
    async putStream(path, body, opts) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of body as AsyncIterable<Buffer>) {
        size += c.length;
        if (opts?.maxBytes !== undefined && size > opts.maxBytes) {
          const err = new Error('too large');
          err.name = 'CustodyTooLargeError';
          throw err;
        }
        chunks.push(Buffer.from(c));
      }
      return put(path, Buffer.concat(chunks));
    },
    getStream: (path) =>
      Promise.resolve(
        m.has(path) ? { entry: entry(path), data: Readable.from([m.get(path)!.data]) } : null,
      ),
    delete: (path) => Promise.resolve(m.delete(path)),
  };
}
