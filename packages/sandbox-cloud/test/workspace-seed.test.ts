import { describe, expect, it } from 'vitest';
import { buildCarryOverSteps, lfsObjectRelPath, parseSeedConflicts } from '../src/sync/workspace-seed.js';

describe('lfsObjectRelPath', () => {
  it('maps an oid to git-lfs content-addressed storage (aa/bb/<oid>)', () => {
    const oid = 'dfbd78a3ce7887c4d9033fd78e690be2c1096a7dfc2194e3cd7030ccd51aa267';
    // This layout is load-bearing: the host-side copy and the in-box tar extract
    // must agree so the in-box smudge finds the object with no network.
    expect(lfsObjectRelPath(oid)).toBe(`lfs/objects/df/bd/${oid}`);
  });
});

describe('parseSeedConflicts', () => {
  it('extracts + dedupes merge-conflict and overlay-skip markers', () => {
    const stdout = [
      'some unrelated git output',
      '__AGENTBOX_MERGE_CONFLICT__:src/a.ts',
      '__AGENTBOX_MERGE_CONFLICT__:src/a.ts', // dup
      '__AGENTBOX_OVERLAY_SKIP__:foo.txt',
      'more noise',
      '__AGENTBOX_OVERLAY_SKIP__:bar/baz.json',
    ].join('\n');
    const r = parseSeedConflicts(stdout);
    expect(r.mergeConflicts).toEqual(['src/a.ts']);
    expect(r.overlaySkipped).toEqual(['foo.txt', 'bar/baz.json']);
  });

  it('returns empty arrays when no markers present', () => {
    expect(parseSeedConflicts('nothing here\n')).toEqual({
      mergeConflicts: [],
      overlaySkipped: [],
    });
  });
});

describe('buildCarryOverSteps', () => {
  it('overlay mode emits box-wins conflict detection + markers, never clobbering', () => {
    const steps = buildCarryOverSteps({
      workspaceDir: '/workspace',
      hasStash: true,
      hasUntracked: true,
      detectConflicts: true,
    }).join('\n');
    // stash conflict → checkout --ours (keep box) + report
    expect(steps).toContain('checkout --ours');
    expect(steps).toContain('__AGENTBOX_MERGE_CONFLICT__:');
    // untracked overlay must not overwrite existing files
    expect(steps).toContain('--skip-old-files');
    expect(steps).toContain('__AGENTBOX_OVERLAY_SKIP__:');
    // The box has no /dev/fd (Firecracker) — use pipes, never process substitution.
    expect(steps).not.toContain('< <(');
  });

  it('fresh mode (no conflict detection) uses the simple apply/extract', () => {
    const steps = buildCarryOverSteps({
      workspaceDir: '/workspace',
      hasStash: true,
      hasUntracked: true,
      detectConflicts: false,
    }).join('\n');
    expect(steps).not.toContain('checkout --ours');
    expect(steps).not.toContain('--skip-old-files');
    expect(steps).not.toContain('__AGENTBOX_');
    expect(steps).toContain('stash apply');
  });

  it('emits no steps when there is nothing to carry over', () => {
    expect(
      buildCarryOverSteps({
        workspaceDir: '/workspace',
        hasStash: false,
        hasUntracked: false,
        detectConflicts: true,
      }),
    ).toEqual([]);
  });
});
