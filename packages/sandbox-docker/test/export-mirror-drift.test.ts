import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceListScript,
  gitModeExcludePathspecs,
  workspaceExcludes,
} from '@agentbox/sandbox-core';
import { exportMirrorExcludes } from '../src/sync/host-export.js';

/**
 * The invariant docker's two-stage pull rests on: the box->scratch MIRROR must
 * be a superset of the SELECTION.
 *
 * A superset is free — `rsync --files-from` ignores the extra files. A subset is
 * fatal: a selected path the mirror never wrote makes rsync exit 23 and takes
 * the whole download with it. That is precisely how this broke — the mirror
 * dropped `node_modules`, and on a repo that does not gitignore it, git listed
 * it anyway.
 *
 * So this test does not check that the two lists are equal (they are not, and
 * should not be — the mirror still copies `.git`, `media/` and sqlite files the
 * selection drops). It checks the one direction that can fail.
 */
describe('the export mirror never drops what the selection keeps', () => {
  for (const includeNodeModules of [false, true]) {
    it(`holds with includeNodeModules: ${String(includeNodeModules)}`, () => {
      const dropped = exportMirrorExcludes({ includeNodeModules });
      const script = buildWorkspaceListScript({
        excludes: workspaceExcludes({ includeNodeModules }),
        includeNodeModules,
      });
      const gitLine = script.split('\n').find((l) => l.includes('git ls-files'))!;
      const findLine = script.split('\n').find((l) => l.includes('find .'))!;

      for (const name of dropped) {
        // Exclude-list mode prunes it by name...
        expect(findLine, `find keeps ${name}`).toContain(`-name '${name}'`);
        // ...and git mode must drop it at every depth the mirror does, since
        // rsync's --exclude matches a basename anywhere.
        for (const spec of [`:(exclude)${name}`, `:(exclude)*/${name}`, `:(exclude)*/${name}/*`]) {
          expect(gitModeExcludePathspecs({ includeNodeModules })).toContain(spec);
          expect(gitLine, `git mode keeps ${name}`).toContain(`'${spec}'`);
        }
      }
    });
  }

  it('drops nothing at all once the user asks for node_modules', () => {
    // The empty case is the point: with nothing dropped there is nothing the
    // selection can ask for that the mirror lacks.
    expect(exportMirrorExcludes({ includeNodeModules: true })).toEqual([]);
  });
});
