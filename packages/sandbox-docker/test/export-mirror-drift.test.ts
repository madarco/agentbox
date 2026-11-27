import { describe, expect, it } from 'vitest';
import { GENERATED_DIR_NAMES } from '@agentbox/sandbox-core';
import { EXCLUDE_DIRS } from '../src/snapshot.js';
import { exportMirrorExcludes, mirrorExcludesForSelection } from '../src/sync/host-export.js';

/**
 * The invariant docker's two-stage pull rests on: the box->scratch MIRROR must
 * be a superset of the SELECTION.
 *
 * A superset is free — `rsync --files-from` ignores the extra files. A subset
 * loses files: a selected path the mirror never wrote is reported missing
 * instead of copied. That is how this first broke — the mirror dropped
 * `node_modules`, and on a repo that does not gitignore it, git listed it.
 *
 * The mirror is now derived from the selection itself, because the selection
 * keeps a TRACKED file under `dist/` while dropping untracked ones there.
 */
describe('mirrorExcludesForSelection', () => {
  it('skips every generated dir the selection never names', () => {
    expect(mirrorExcludesForSelection(['src/a.ts', 'README.md'])).toEqual([...GENERATED_DIR_NAMES]);
  });

  it('keeps a generated dir once any selected path goes through it', () => {
    // A tracked `dist/committed.js` and an `--all` nested `.venv` file.
    const ex = mirrorExcludesForSelection(['dist/committed.js', 'svc/.venv/pyvenv.cfg']);
    expect(ex).not.toContain('dist');
    expect(ex).not.toContain('.venv');
    expect(ex).toContain('node_modules');
  });

  it('keeps a name that is a selected FILE, so the tar fallback cannot drop it', () => {
    expect(mirrorExcludesForSelection(['scripts/build'])).not.toContain('build');
  });

  it('never excludes a path the selection holds', () => {
    const selection = [
      'dist/committed.js',
      'packages/web/node_modules/x/i.js',
      'distribution/a',
      'my_build.py',
      'src/app.py',
    ];
    const ex = mirrorExcludesForSelection(selection);
    for (const p of selection) {
      for (const seg of p.split('/')) expect(ex, `${p} would be dropped`).not.toContain(seg);
    }
  });

  it('is what refreshExport uses when a pull hands it over', () => {
    expect(exportMirrorExcludes({ mirrorExcludes: ['dist'] })).toEqual(['dist']);
    // `open` / `path` keep their own default.
    expect(exportMirrorExcludes()).toEqual(['node_modules']);
    expect(exportMirrorExcludes({ includeNodeModules: true })).toEqual([]);
  });
});

describe('the docker host snapshot', () => {
  it('prunes the shared list plus .agentbox, and nothing that can drift', () => {
    expect([...EXCLUDE_DIRS].sort()).toEqual(['.agentbox', ...GENERATED_DIR_NAMES].sort());
    expect(EXCLUDE_DIRS.has('venv')).toBe(true);
  });
});
