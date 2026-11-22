import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localMemoryDir, readLocalMemory, writeMemoryFile } from '../src/lib/memory-local.js';

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
});
