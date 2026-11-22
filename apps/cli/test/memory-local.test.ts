import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupMemoryFiles,
  localMemoryDir,
  planPull,
  readLocalMemory,
  writeMemoryFile,
} from '../src/lib/memory-local.js';

describe('memory-local', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mem-local-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("maps a project folder to claude's host memory dir", () => {
    expect(localMemoryDir('claude', '/Users/x/my.proj', '/home/u')).toBe(
      '/home/u/.claude/projects/-Users-x-my-proj/memory',
    );
  });

  it('refuses an agent that declares no memory', () => {
    expect(() => localMemoryDir('pi', '/p', '/home/u')).toThrow(/declares no memory/);
  });

  it('reads regular files only and writes atomically, refusing escaping paths', async () => {
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'MEMORY.md'), 'index');
    await writeFile(join(dir, 'sub', 'a.md'), 'a');
    await symlink('/etc/hostname', join(dir, 'link.md'));
    const m = await readLocalMemory(dir);
    expect([...m.keys()]).toEqual(['MEMORY.md', 'sub/a.md']);
    await writeMemoryFile(dir, 'new/b.md', Buffer.from('b'));
    expect(await readFile(join(dir, 'new', 'b.md'), 'utf8')).toBe('b');
    await expect(writeMemoryFile(dir, '../x.md', Buffer.from('x'))).rejects.toThrow(/refusing/);
  });

  it('plans adds, updates and tombstone deletes, and never touches PC-only files', async () => {
    const local = new Map([
      ['MEMORY.md', Buffer.from('pc index')],
      ['same.md', Buffer.from('same')],
      ['gone.md', Buffer.from('deleted on the hub')],
      ['mine.md', Buffer.from('written on the PC, never shipped')],
    ]);
    const hub: Record<string, string> = {
      'MEMORY.md': 'hub index',
      'same.md': 'same',
      'new.md': 'n',
    };
    const plan = await planPull(
      [
        { path: 'MEMORY.md', version: 3, deleted: false },
        { path: 'same.md', version: 1, deleted: false },
        { path: 'new.md', version: 1, deleted: false },
        { path: 'gone.md', version: 2, deleted: true },
        { path: 'never-here.md', version: 2, deleted: true },
      ],
      local,
      async (p) => Buffer.from(hub[p]!),
    );
    expect(plan.map((e) => [e.path, e.action])).toEqual([
      ['MEMORY.md', 'update'],
      ['same.md', 'same'],
      ['new.md', 'add'],
      ['gone.md', 'delete'],
      ['mine.md', 'local'],
    ]);
    expect(plan[0]!.bytes?.toString()).toBe('hub index');
  });

  it('backs up the files a pull overwrites, outside the memory dir', async () => {
    const mem = join(dir, '.claude', 'projects', '-p', 'memory');
    await mkdir(mem, { recursive: true });
    await writeFile(join(mem, 'MEMORY.md'), 'old index');
    const out = await backupMemoryFiles(mem, ['MEMORY.md'], 'claude', 'stamp', join(dir, 'bk'));
    expect(out).toBe(join(dir, 'bk', 'claude', '-p', 'stamp'));
    expect(await readFile(join(out!, 'MEMORY.md'), 'utf8')).toBe('old index');
    expect(await backupMemoryFiles(mem, [], 'claude')).toBeNull();
  });
});
