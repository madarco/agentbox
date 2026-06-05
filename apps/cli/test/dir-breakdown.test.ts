import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CP_EXCLUDES,
  effectiveExcludes,
  fmtBytes,
  isPathExcluded,
  measureCopy,
  toTarExcludes,
} from '../src/lib/dir-breakdown.js';

describe('effectiveExcludes', () => {
  it('prepends defaults then user tokens, de-duped', () => {
    const out = effectiveExcludes(['node_modules', 'custom'], true);
    expect(out).toContain('.git');
    expect(out).toContain('custom');
    // node_modules appears once even though it is both a default and user token
    expect(out.filter((t) => t === 'node_modules')).toHaveLength(1);
  });

  it('omits defaults when useDefaults is false', () => {
    expect(effectiveExcludes(['only'], false)).toEqual(['only']);
  });
});

describe('toTarExcludes', () => {
  it('expands a bare name to match at any depth', () => {
    expect(toTarExcludes(['.git'])).toEqual(['*/.git', '.git']);
  });

  it('passes globs and paths through verbatim', () => {
    expect(toTarExcludes(['*/cache', 'a/b'])).toEqual(['*/cache', 'a/b']);
  });
});

describe('isPathExcluded', () => {
  it('matches a bare name on any path component', () => {
    expect(isPathExcluded('a/node_modules/x', ['node_modules'])).toBe(true);
    expect(isPathExcluded('a/src/x', ['node_modules'])).toBe(false);
  });

  it('matches a glob against the full relpath', () => {
    expect(isPathExcluded('a/cache', ['*/cache'])).toBe(true);
  });
});

describe('fmtBytes', () => {
  it('renders human sizes', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2 * 1024 * 1024)).toBe('2 MB');
  });
});

describe('measureCopy', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agb-breakdown-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function bigFile(path: string, bytes: number): Promise<void> {
    await writeFile(path, Buffer.alloc(bytes, 1));
  }

  it('excludes default heavy dirs from the total', async () => {
    await mkdir(join(dir, 'node_modules'));
    await bigFile(join(dir, 'node_modules', 'big.bin'), 5 * 1024 * 1024);
    await mkdir(join(dir, 'src'));
    await bigFile(join(dir, 'src', 'app.bin'), 2 * 1024 * 1024);

    const withDefaults = await measureCopy(dir, effectiveExcludes([], true));
    expect(withDefaults.totalBytes).toBe(2 * 1024 * 1024); // node_modules dropped

    const noDefaults = await measureCopy(dir, effectiveExcludes([], false));
    expect(noDefaults.totalBytes).toBe(7 * 1024 * 1024); // everything counted
  });

  it('reports top children biggest-first', async () => {
    await mkdir(join(dir, 'small'));
    await bigFile(join(dir, 'small', 'a.bin'), 1 * 1024 * 1024);
    await mkdir(join(dir, 'large'));
    await bigFile(join(dir, 'large', 'b.bin'), 20 * 1024 * 1024);

    const r = await measureCopy(dir, []);
    expect(r.isDir).toBe(true);
    expect(r.topChildren[0]?.path).toBe('large');
    // the tree includes the heavy subfolder above the 10 MiB floor
    expect(r.treeLines.some((l) => l.includes('./large'))).toBe(true);
  });

  it('returns a flat size for a file source', async () => {
    const f = join(dir, 'solo.bin');
    await bigFile(f, 1234);
    const r = await measureCopy(f, []);
    expect(r.isDir).toBe(false);
    expect(r.totalBytes).toBe(1234);
    expect(r.treeLines).toEqual([]);
  });
});

describe('DEFAULT_CP_EXCLUDES', () => {
  it('covers the documented heavy dirs', () => {
    for (const name of ['.git', 'node_modules', 'packages', 'dist']) {
      expect(DEFAULT_CP_EXCLUDES).toContain(name);
    }
  });
});
