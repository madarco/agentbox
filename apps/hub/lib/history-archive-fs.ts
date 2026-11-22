// The history archive on the local filesystem (`~/.agentbox/hub/history/`).
// Object storage slots in behind the same `HistoryArchive` interface later.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { HistoryArchive } from './backend/history';

export function fsHistoryArchive(root: string): HistoryArchive {
  const base = resolve(root);
  const pathOf = (key: string): string => {
    const p = resolve(join(base, key));
    if (!p.startsWith(base + sep)) throw new Error(`history archive key escapes the root: ${key}`);
    return p;
  };
  return {
    async put(key, bytes) {
      const p = pathOf(key);
      await mkdir(dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${String(process.pid)}`;
      await writeFile(tmp, bytes);
      await rename(tmp, p);
    },
    get: (key) => readFile(pathOf(key)),
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}
