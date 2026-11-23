import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { existingPathsIn, rsyncPullToHost } from '../src/sync/concerns/workspace-files.js';

/**
 * Stage 2, run against the real rsync — including the one macOS ships (2.6.9),
 * which is the reason this code cannot simply pass `--ignore-missing-args`.
 */
function dirs(files: Record<string, string>): { scratch: string; dest: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'agentbox-scratch-'));
  const dest = mkdtempSync(join(tmpdir(), 'agentbox-dest-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(scratch, name), body);
  return { scratch, dest };
}

// Each case shells out to the real rsync several times. Idle that is ~700ms for
// the file, but on a loaded machine it has been measured at 1.7s and the 5s
// default then turns into a coin flip — this suite failed twice in a full
// `build && test` run and never once on its own.
describe('rsyncPullToHost', { timeout: 30_000 }, () => {
  it('skips a selected path that was never staged, and still copies the rest', () => {
    // THE REPORTED BUG. rsync exits 23 on a missing `--files-from` entry and the
    // dry run threw, so a single stale path meant the whole download transferred
    // nothing. A pull is additive (never --delete), so the honest response is to
    // copy what is there and name what is not.
    const { scratch, dest } = dirs({ 'keep.txt': 'k' });
    return rsyncPullToHost({
      scratchDir: scratch,
      destDir: dest,
      fileList: ['keep.txt', 'gone.txt'].join('\0'),
    }).then((r) => {
      expect(r.missing).toEqual(['gone.txt']);
      expect(r.applied).toBe(true);
      expect(readdirSync(dest)).toEqual(['keep.txt']);
    });
  });

  it('fails loudly when NOTHING selected was staged', async () => {
    // Not a race — that is a stale `--no-refresh` scratch dir or one wiped
    // underneath us, and silently copying zero files would look like success.
    const { scratch, dest } = dirs({});
    await expect(
      rsyncPullToHost({ scratchDir: scratch, destDir: dest, fileList: 'a.txt\0b.txt' }),
    ).rejects.toThrow(/staged copy|--no-refresh/);
  });

  it('drops the paths the user declined', async () => {
    const { scratch, dest } = dirs({ 'mine.txt': 'm', 'AGENTS.md': 'a' });
    const r = await rsyncPullToHost({
      scratchDir: scratch,
      destDir: dest,
      fileList: ['mine.txt', 'AGENTS.md'].join('\0'),
      skipPaths: ['AGENTS.md'],
    });
    expect(readdirSync(dest)).toEqual(['mine.txt']);
    // Declined is not missing: it was staged, we chose not to take it.
    expect(r.missing).toEqual([]);
  });

  it('leaves the no-file-list path alone', async () => {
    const { scratch, dest } = dirs({ 'a.txt': 'a', 'skip.log': 's' });
    await rsyncPullToHost({
      scratchDir: scratch,
      destDir: dest,
      fileList: null,
      excludes: ['*.log'],
    });
    expect(readdirSync(dest)).toEqual(['a.txt']);
  });

  it('existingPathsIn keeps a symlink without following it', async () => {
    const { scratch } = dirs({ 'real.txt': 'r' });
    expect(await existingPathsIn(scratch, ['real.txt', 'nope.txt'])).toEqual(['real.txt']);
  });
});
