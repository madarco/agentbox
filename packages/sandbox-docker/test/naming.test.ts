import { describe, expect, it } from 'vitest';
import { defaultBoxName, sanitizeBasename } from '../src/create.js';

describe('sanitizeBasename', () => {
  it('passes through a clean basename unchanged', () => {
    expect(sanitizeBasename('/Users/marco/myproject')).toBe('myproject');
  });

  it('lowercases and replaces spaces with single dashes', () => {
    expect(sanitizeBasename('/Users/marco/My Project')).toBe('my-project');
  });

  it('replaces runs of disallowed chars with a single dash and keeps underscores', () => {
    expect(sanitizeBasename('/tmp/foo___bar!!!baz')).toBe('foo___bar-baz');
  });

  it('strips leading dots so dotdirs become readable', () => {
    expect(sanitizeBasename('/Users/marco/.dotdir')).toBe('dotdir');
  });

  it('truncates to 30 chars and re-trims trailing separators', () => {
    const long = '/tmp/' + 'a'.repeat(28) + '----------';
    const out = sanitizeBasename(long);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out).not.toMatch(/[-._]$/);
  });

  it('returns empty for the filesystem root', () => {
    expect(sanitizeBasename('/')).toBe('');
  });

  it('preserves embedded dots and underscores', () => {
    expect(sanitizeBasename('/tmp/foo.bar_baz')).toBe('foo.bar_baz');
  });
});

describe('defaultBoxName', () => {
  it('joins sanitized basename with id', () => {
    expect(defaultBoxName('/Users/marco/myproject', 'a1b2c3d4')).toBe('myproject-a1b2c3d4');
  });

  it('falls back to bare id when basename sanitizes to empty', () => {
    expect(defaultBoxName('/', 'a1b2c3d4')).toBe('a1b2c3d4');
  });

  it('sanitizes spaces in workspace folder', () => {
    expect(defaultBoxName('/tmp/My Test Workspace', 'deadbeef')).toBe('my-test-workspace-deadbeef');
  });

  // A control box builds every box from a per-job clone it deletes on the way
  // out, so the workspace basename names a directory that no longer exists and
  // identifies no project. `nameBasis` (the repo) overrides it.
  it('prefers nameBasis over the workspace basename', () => {
    expect(
      defaultBoxName('/tmp/agentbox-hub-worker-74d57005-7edf-46ea', 'bf16245c8', 'optima'),
    ).toBe('optima-bf16245c8');
  });

  it('sanitizes nameBasis like any other name token', () => {
    expect(defaultBoxName('/tmp/whatever', 'deadbeef', 'My Repo')).toBe('my-repo-deadbeef');
  });

  it('falls back to the workspace basename when nameBasis sanitizes to empty', () => {
    expect(defaultBoxName('/Users/marco/myproject', 'a1b2c3d4', '')).toBe('myproject-a1b2c3d4');
  });
});
