import { describe, expect, it } from 'vitest';
import { createMemoryService, type MemoryKey } from '../lib/backend/history-memory';
import { openSqliteMemoryRepo } from '../lib/history-sqlite';

const key: MemoryKey = { repoKey: 'github.com/o/r', agent: 'claude', scope: 'project' };
const box = (id: string) => ({ boxId: id, boxName: id, provider: 'docker' });
const host = { boxId: null, provider: 'host' };
const b = (s: string) => Buffer.from(s);

async function service() {
  let t = 1000;
  return createMemoryService({ repo: await openSqliteMemoryRepo(':memory:'), now: () => t++ });
}

describe('memory service', () => {
  it('imports the host copy on the first seed and keeps the hub authoritative after', async () => {
    const m = await service();
    const first = await m.memorySeed({
      ...key,
      hostFiles: [{ path: 'MEMORY.md', bytes: b('host index') }],
      origin: host,
    });
    expect(first.map((f) => [f.path, Buffer.from(f.bytes).toString()])).toEqual([
      ['MEMORY.md', 'host index'],
    ]);
    await m.memoryPut({ ...key, path: 'MEMORY.md', bytes: b('box index'), origin: box('a') });
    // A changed host copy no longer wins on a path the hub holds; a new host path joins.
    const second = await m.memorySeed({
      ...key,
      hostFiles: [
        { path: 'MEMORY.md', bytes: b('host index v2') },
        { path: 'new.md', bytes: b('n') },
      ],
      origin: host,
    });
    expect(second.map((f) => [f.path, Buffer.from(f.bytes).toString()])).toEqual([
      ['MEMORY.md', 'box index'],
      ['new.md', 'n'],
    ]);
  });

  it('keeps every version, last writer wins, identical content is a no-op', async () => {
    const m = await service();
    expect(await m.memoryPut({ ...key, path: 'a.md', bytes: b('1'), origin: box('a') })).toEqual({
      version: 1,
      changed: true,
    });
    expect(await m.memoryPut({ ...key, path: 'a.md', bytes: b('1'), origin: box('b') })).toEqual({
      version: 1,
      changed: false,
    });
    await m.memoryPut({ ...key, path: 'a.md', bytes: b('2'), origin: box('b') });
    const vs = await m.versions(key, 'a.md');
    expect(vs.map((v) => [v.version, v.origin.boxId])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect((await m.file(key, 'a.md'))?.bytes.toString()).toBe('2');
    expect((await m.file(key, 'a.md', 1))?.bytes.toString()).toBe('1');
  });

  it('a tombstone hides the path from list and seed, and keeps it out of the host import', async () => {
    const m = await service();
    await m.memoryPut({ ...key, path: 'x.md', bytes: b('x'), origin: box('a') });
    await m.memoryPut({ ...key, path: 'x.md', bytes: null, origin: box('a') });
    expect(await m.list(key)).toEqual([]);
    expect(await m.file(key, 'x.md')).toBeNull();
    const seeded = await m.memorySeed({
      ...key,
      hostFiles: [{ path: 'x.md', bytes: b('x from host') }],
      origin: host,
    });
    expect(seeded).toEqual([]);
    expect((await m.sets())[0]).toMatchObject({ ...key, files: 0, versions: 2 });
  });

  it('refuses a path that escapes the dir', async () => {
    const m = await service();
    await expect(
      m.memoryPut({ ...key, path: '../x.md', bytes: b('x'), origin: box('a') }),
    ).rejects.toThrow(/invalid memory path/);
  });

  it('separates repos and agents', async () => {
    const m = await service();
    await m.memoryPut({ ...key, path: 'a.md', bytes: b('1'), origin: box('a') });
    expect(await m.list({ ...key, repoKey: 'github.com/o/other' })).toEqual([]);
    expect(await m.list({ ...key, agent: 'codex' })).toEqual([]);
    expect((await m.list(key)).map((f) => f.path)).toEqual(['a.md']);
  });
});
