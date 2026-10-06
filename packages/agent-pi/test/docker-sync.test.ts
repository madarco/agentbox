import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stagePiConfigForDocker } from '../src/docker-sync.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('stagePiConfigForDocker', () => {
  it('materializes absolute and escaping relative skill links and skips broken links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbox-pi-stage-'));
    roots.push(root);
    const piDir = join(root, '.pi', 'agent');
    const shared = join(root, 'shared');
    await mkdir(join(piDir, 'skills'), { recursive: true });
    await mkdir(join(shared, 'absolute-skill'), { recursive: true });
    await mkdir(join(shared, 'relative-skill'), { recursive: true });
    await writeFile(join(shared, 'absolute-skill', 'SKILL.md'), 'absolute');
    await writeFile(join(shared, 'relative-skill', 'SKILL.md'), 'relative');
    await symlink(join(shared, 'absolute-skill'), join(piDir, 'skills', 'absolute-skill'));
    await symlink('../../../shared/relative-skill', join(piDir, 'skills', 'relative-skill'));
    await symlink(join(shared, 'missing'), join(piDir, 'skills', 'broken-skill'));
    await mkdir(join(piDir, 'sessions'), { recursive: true });
    await writeFile(join(piDir, 'sessions', 'host-session.json'), '{}');

    const staged = await stagePiConfigForDocker(piDir);
    try {
      expect(
        await readFile(join(staged.path, 'skills', 'absolute-skill', 'SKILL.md'), 'utf8'),
      ).toBe('absolute');
      expect(
        await readFile(join(staged.path, 'skills', 'relative-skill', 'SKILL.md'), 'utf8'),
      ).toBe('relative');
      expect((await lstat(join(staged.path, 'skills', 'absolute-skill'))).isSymbolicLink()).toBe(
        false,
      );
      await expect(lstat(join(staged.path, 'skills', 'broken-skill'))).rejects.toThrow();
      await expect(lstat(join(staged.path, 'sessions'))).rejects.toThrow();
    } finally {
      await staged.cleanup();
    }
  });
});
