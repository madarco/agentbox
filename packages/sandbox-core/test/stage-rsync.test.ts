import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageRsync } from '../src/sync/host-stage.js';

/** A fake `rsync` first on PATH that exits with `$FAKE_RSYNC_EXIT`. */
let binDir: string;
const savedPath = process.env['PATH'];

beforeEach(async () => {
  binDir = await mkdtemp(join(tmpdir(), 'stage-rsync-'));
  const fake = join(binDir, 'rsync');
  await writeFile(fake, '#!/bin/sh\nexit "${FAKE_RSYNC_EXIT:-0}"\n');
  await chmod(fake, 0o755);
  process.env['PATH'] = `${binDir}:${savedPath ?? ''}`;
});

afterEach(async () => {
  process.env['PATH'] = savedPath;
  delete process.env['FAKE_RSYNC_EXIT'];
  await rm(binDir, { recursive: true, force: true });
});

describe('stageRsync', () => {
  it('resolves on success', async () => {
    process.env['FAKE_RSYNC_EXIT'] = '0';
    await expect(stageRsync(['-a', 'src/', 'dst/'])).resolves.toBeUndefined();
  });

  it('resolves on exit 24: a live agent removed a file mid-copy', async () => {
    process.env['FAKE_RSYNC_EXIT'] = '24';
    await expect(stageRsync(['-a', 'src/', 'dst/'])).resolves.toBeUndefined();
  });

  it('throws on any other failure', async () => {
    process.env['FAKE_RSYNC_EXIT'] = '23';
    await expect(stageRsync(['-a', 'src/', 'dst/'])).rejects.toMatchObject({ exitCode: 23 });
  });
});
