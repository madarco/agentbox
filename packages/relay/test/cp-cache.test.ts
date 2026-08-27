import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cpCacheKey,
  cpCacheKeyInput,
  cpCacheMetaPath,
  cpCachePrefix,
  cpCacheTarPath,
  describeCacheAge,
  parseCpCacheMeta,
} from '../src/cp-cache.js';
import { describeCpCacheEntries, lookupCpCache } from '../src/cp-cache-serve.js';
import { FsCustodyStore } from '../src/custody/fs-store.js';

describe('cp cache keys', () => {
  it('keys by project when the box has an origin, so boxes of one project share entries', () => {
    expect(cpCachePrefix({ projectSlug: 'acme__web', boxId: 'b1' })).toBe('projects/acme__web/cp');
  });

  it('falls back to the box when there is no project slug, rather than to no cache at all', () => {
    expect(cpCachePrefix({ boxId: 'b1' })).toBe('boxes/b1/cp');
    expect(cpCachePrefix({ projectSlug: '  ', boxId: 'b1' })).toBe('boxes/b1/cp');
  });

  it('produces a custody-legal single segment for any host path', () => {
    // Custody rejects `/` and `.` segments, which is exactly why the path is
    // hashed rather than encoded.
    const p = cpCacheTarPath('projects/acme__web/cp', '/Users/marco/data/q3 report.csv');
    const segments = p.split('/');
    expect(segments).toHaveLength(4);
    expect(segments[3]).toMatch(/^[a-f0-9]{32}\.tar$/);
  });

  it('keys on the request, not on a resolved path — the two machines resolve differently', () => {
    // The owning machine resolves `./data.csv` against the real project; the
    // control box against a temp clone it has already deleted. Keying on either
    // resolution meant every write landed where the read could not look.
    expect(cpCacheKeyInput('./data.csv')).toBe('rel:data.csv');
    expect(cpCacheKeyInput('data.csv')).toBe('rel:data.csv');
    expect(cpCacheKeyInput('././sub/data.csv')).toBe('rel:sub/data.csv');
    expect(cpCacheKeyInput('/Users/me/data.csv')).toBe('abs:/Users/me/data.csv');
    expect(cpCacheKeyInput('/Users/me/dir/')).toBe('abs:/Users/me/dir');
    // A box asking `./data.csv` and an upload of the same project-relative path
    // must meet at one entry.
    expect(cpCacheKey('./data.csv')).toBe(cpCacheKey('data.csv'));
    // ...and a relative path is never confused with an absolute one.
    expect(cpCacheKey('data.csv')).not.toBe(cpCacheKey('/data.csv'));
  });

  it('gives one path one key, and different paths different keys', () => {
    expect(cpCacheKey('/a/b.csv')).toBe(cpCacheKey('/a/b.csv'));
    expect(cpCacheKey('/a/b.csv')).not.toBe(cpCacheKey('/a/c.csv'));
    // The sidecar sits beside the tar under the same key.
    expect(cpCacheMetaPath('p/x/cp', '/a/b.csv').replace(/\.json$/, '')).toBe(
      cpCacheTarPath('p/x/cp', '/a/b.csv').replace(/\.tar$/, ''),
    );
  });

  it('describes age in units a reader can act on', () => {
    const now = Date.parse('2026-08-27T12:00:00Z');
    expect(describeCacheAge('2026-08-27T11:59:30Z', now)).toBe('captured 30s ago');
    expect(describeCacheAge('2026-08-27T11:00:00Z', now)).toBe('captured 60m ago');
    expect(describeCacheAge('2026-08-25T12:00:00Z', now)).toBe('captured 2d ago');
    expect(describeCacheAge('not-a-date', now)).toBe('captured at an unknown time');
  });

  it('treats a corrupt sidecar as no cache rather than as an entry with no age', () => {
    expect(parseCpCacheMeta('{')).toBeNull();
    expect(parseCpCacheMeta('{"isDir":true}')).toBeNull();
    expect(
      parseCpCacheMeta('{"sourcePath":"/a","capturedAt":"2026-01-01T00:00:00Z"}'),
    ).toMatchObject({ sourcePath: '/a', isDir: false });
  });
});

describe('cache lookup', () => {
  let dir: string;
  let custody: FsCustodyStore;
  const prefix = 'projects/acme__web/cp';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-cp-cache-test-'));
    custody = new FsCustodyStore({ root: dir });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(sourcePath: string, capturedAt: string): Promise<void> {
    await custody.put(
      cpCacheTarPath(prefix, sourcePath),
      Buffer.from('tar-bytes-placeholder', 'utf8'),
    );
    await custody.put(
      cpCacheMetaPath(prefix, sourcePath),
      Buffer.from(JSON.stringify({ sourcePath, isDir: false, capturedAt, size: 21 }), 'utf8'),
    );
  }

  it('reports exactly which sources are missing, so a partial set can be refused', async () => {
    await seed('/Users/marco/p/a.csv', '2026-08-27T10:00:00Z');
    const lookup = await lookupCpCache(['/Users/marco/p/a.csv', '/Users/marco/p/b.csv'], {
      custody,
      cachePrefix: prefix,
    });
    expect(lookup.entries.map((e) => e.sourcePath)).toEqual(['/Users/marco/p/a.csv']);
    expect(lookup.missing).toEqual(['/Users/marco/p/b.csv']);
  });

  it('counts a tar with no sidecar as missing — an entry with no age is unusable', async () => {
    await custody.put(cpCacheTarPath(prefix, '/x/y.bin'), Buffer.from('bytes'));
    const lookup = await lookupCpCache(['/x/y.bin'], { custody, cachePrefix: prefix });
    expect(lookup.entries).toHaveLength(0);
    expect(lookup.missing).toEqual(['/x/y.bin']);
  });

  it('has no cache at all when custody is not wired', async () => {
    const lookup = await lookupCpCache(['/x/y.bin'], { custody: null, cachePrefix: prefix });
    expect(lookup.missing).toEqual(['/x/y.bin']);
  });

  it('renders each entry with its age for the approval and the box', async () => {
    await seed('/Users/marco/p/a.csv', new Date(Date.now() - 3_600_000).toISOString());
    const lookup = await lookupCpCache(['/Users/marco/p/a.csv'], { custody, cachePrefix: prefix });
    expect(describeCpCacheEntries(lookup)).toMatch(
      /\/Users\/marco\/p\/a\.csv \(captured 60m ago\)/,
    );
  });
});
