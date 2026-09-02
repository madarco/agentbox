import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertEmptyDir } from '../src/sync/concerns/workspace-clone.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentbox-clone-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('assertEmptyDir', () => {
  it('accepts an absent path — the export creates it', async () => {
    await expect(assertEmptyDir(join(root, 'nope'))).resolves.toBeUndefined();
  });

  it('accepts an existing empty directory', async () => {
    const dir = join(root, 'empty');
    await mkdir(dir);
    await expect(assertEmptyDir(dir)).resolves.toBeUndefined();
  });

  it('refuses a non-empty directory', async () => {
    const dir = join(root, 'full');
    await mkdir(dir);
    await writeFile(join(dir, 'a.txt'), 'x');
    await expect(assertEmptyDir(dir)).rejects.toThrow(/is not empty/);
  });

  it('refuses an existing FILE instead of treating it as absent', async () => {
    // Regression: `readdir` on a file fails with ENOTDIR, the old code caught
    // every error as "absent", and `stageBoxWorkspace` then `rm -rf`d the path.
    // `agentbox clone --into ~/notes.md` destroyed notes.md.
    const file = join(root, 'notes.md');
    await writeFile(file, 'important\n');
    await expect(assertEmptyDir(file)).rejects.toThrow(/exists and is not a directory/);
    // And the file is untouched — the whole point.
    expect(await readFile(file, 'utf8')).toBe('important\n');
  });

  it('refuses a symlink rather than replacing the link', async () => {
    const target = join(root, 'real');
    const link = join(root, 'link');
    await mkdir(target);
    await symlink(target, link);
    await expect(assertEmptyDir(link)).rejects.toThrow(/symlink/);
  });
});
