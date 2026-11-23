import { describe, expect, it } from 'vitest';
import { createMemoryService, type MemoryKey } from '../lib/backend/history-memory';
import { openSqliteMemoryRepo } from '../lib/history-sqlite';

const key: MemoryKey = { repoKey: 'github.com/o/r', agent: 'claude', scope: 'project' };
const box = (id: string) => ({ boxId: id, boxName: id, provider: 'docker' });
const host = { boxId: null, provider: 'host', hostId: 'pc-1' };
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
    // An unchanged host copy does not override the newer box version.
    const second = await m.memorySeed({
      ...key,
      hostFiles: [
        { path: 'MEMORY.md', bytes: b('host index') },
        { path: 'new.md', bytes: b('n') },
      ],
      origin: host,
    });
    expect(second.map((f) => [f.path, Buffer.from(f.bytes).toString()])).toEqual([
      ['MEMORY.md', 'box index'],
      ['new.md', 'n'],
    ]);
  });

  it('a host edit to a known path reaches the next seed (the host is a writer too)', async () => {
    const m = await service();
    const seed = (content: string) =>
      m.memorySeed({ ...key, hostFiles: [{ path: 'MEMORY.md', bytes: b(content) }], origin: host });
    await seed('host v1');
    await m.memoryPut({ ...key, path: 'MEMORY.md', bytes: b('box v2'), origin: box('a') });
    const after = await seed('host v3, edited on the PC');
    expect(Buffer.from(after[0]!.bytes).toString()).toBe('host v3, edited on the PC');
    expect((await m.versions(key, 'MEMORY.md')).map((v) => v.origin.provider)).toEqual([
      'host',
      'docker',
      'host',
    ]);
    // Seeding again with the same host bytes adds nothing.
    await seed('host v3, edited on the PC');
    expect(await m.versions(key, 'MEMORY.md')).toHaveLength(3);
  });

  it('a host edit brings back a path a box deleted; an unchanged host file does not', async () => {
    const m = await service();
    const seed = (content: string) =>
      m.memorySeed({ ...key, hostFiles: [{ path: 'f.md', bytes: b(content) }], origin: host });
    await seed('fact');
    await m.memoryPut({ ...key, path: 'f.md', bytes: null, origin: box('a') });
    expect(await seed('fact')).toEqual([]);
    expect((await seed('fact, edited')).map((f) => f.path)).toEqual(['f.md']);
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

  it('a tombstone hides the path from list and file', async () => {
    const m = await service();
    await m.memoryPut({ ...key, path: 'x.md', bytes: b('x'), origin: box('a') });
    await m.memoryPut({ ...key, path: 'x.md', bytes: null, origin: box('a') });
    expect(await m.list(key)).toEqual([]);
    expect(await m.file(key, 'x.md')).toBeNull();
    expect(await m.memorySeed({ ...key, hostFiles: [], origin: host })).toEqual([]);
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
