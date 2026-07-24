import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProjectSeed, buildProjectSeed, pushProjectSeedToCustody } from '../src/custody-seed.js';

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

/**
 * A repo with one committed file, one untracked file, one gitignored build
 * artifact, and a `.env` — i.e. the four cases the seed has to tell apart.
 */
async function makeRepo(): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentbox-seed-repo-')));
  scratch.push(dir);
  await execa('git', ['-C', dir, 'init', '-q']);
  await execa('git', ['-C', dir, 'config', 'user.email', 't@t.test']);
  await execa('git', ['-C', dir, 'config', 'user.name', 'T']);
  await execa('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git']);
  await writeFile(join(dir, 'committed.txt'), 'tracked');
  await writeFile(join(dir, '.gitignore'), 'ignored-build/\n.env\n');
  await execa('git', ['-C', dir, 'add', '.']);
  await execa('git', ['-C', dir, 'commit', '-qm', 'init']);
  // Untracked, not ignored -> must be captured.
  await writeFile(join(dir, 'scratch-notes.md'), 'local notes');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'wip.ts'), 'export const wip = 1;');
  // Ignored build output -> must NOT be captured.
  await mkdir(join(dir, 'ignored-build'), { recursive: true });
  await writeFile(join(dir, 'ignored-build', 'out.js'), 'junk');
  // Gitignored secret -> captured via the env patterns, not the untracked tar.
  await writeFile(join(dir, '.env'), 'API_KEY=shh');
  return dir;
}

/** List the paths inside a gzipped tar buffer. */
async function tarPaths(data: Buffer): Promise<string[]> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentbox-seed-tar-')));
  scratch.push(dir);
  const file = join(dir, 't.tar.gz');
  await writeFile(file, data);
  const r = await execa('tar', ['-tzf', file]);
  return r.stdout
    .split('\n')
    .map((s) => s.replace(/^\.\//, '').trim())
    .filter((s) => s.length > 0);
}

describe('buildProjectSeed', () => {
  it('captures untracked files and env/secrets, and records the origin + head', async () => {
    const repo = await makeRepo();
    const res = await buildProjectSeed({ projectRoot: repo, envPatterns: ['.env'] });

    const paths = res.items.map((i) => i.relPath).sort();
    expect(paths).toContain('untracked.tar.gz');
    expect(paths).toContain('env.tar.gz');
    expect(await tarPaths(res.items.find((i) => i.relPath === 'env.tar.gz')!.data)).toContain('.env');

    const tar = res.items.find((i) => i.relPath === 'untracked.tar.gz')!;
    const inTar = await tarPaths(tar.data);
    expect(inTar).toContain('scratch-notes.md');
    expect(inTar).toContain('src/wip.ts');
    // Committed files come from the clone; shipping them would be waste.
    expect(inTar).not.toContain('committed.txt');
    // Gitignored build output must never ride along.
    expect(inTar.some((p) => p.startsWith('ignored-build'))).toBe(false);

    expect(res.manifest.originUrl).toBe('https://github.com/o/r.git');
    expect(res.manifest.repoHeadSha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.manifest.files.map((f) => f.path).sort()).toEqual(paths);
    for (const f of res.manifest.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('drops an oversized untracked tar but still captures env files', async () => {
    const repo = await makeRepo();
    // maxBodyBytes is the custody PUT cap; the blob ceiling is derived from it.
    const res = await buildProjectSeed({ projectRoot: repo, envPatterns: ['.env'], maxBodyBytes: 1 });
    expect(res.skippedTarBytes).toBeGreaterThan(1);
    expect(res.items.map((i) => i.relPath)).toEqual(['env.tar.gz']);
    // A partial seed still beats none — and the manifest says what's in it.
    expect(res.manifest.files.map((f) => f.path)).toEqual(['env.tar.gz']);
  });

  it('keeps nested env files at their repo-relative paths (monorepo layouts)', async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, 'apps', 'web'), { recursive: true });
    await writeFile(join(repo, 'apps', 'web', '.env.local'), 'NESTED=1');
    const res = await buildProjectSeed({ projectRoot: repo, envPatterns: ['.env', '.env.*'] });

    // Regression: env files used to be one custody entry each, at
    // `projects/<slug>/seed/env/<rel>` — which for `apps/web/.env.local` is 7
    // segments against custody's 6-segment cap, so the push failed outright for
    // exactly the monorepo layouts that most need seeding. A tar has no depth limit.
    const envTar = res.items.find((i) => i.relPath === 'env.tar.gz');
    expect(envTar).toBeDefined();
    const inside = await tarPaths(envTar!.data);
    expect(inside).toContain('apps/web/.env.local');
    expect(inside).toContain('.env');
    // Every custody path stays within the store's 6-segment limit.
    for (const item of res.items) {
      expect(`projects/o__r/seed/${item.relPath}`.split('/').length).toBeLessThanOrEqual(6);
    }
  });

  it('reports which env files it captured, so the scope is never a mystery', async () => {
    const repo = await makeRepo();
    const res = await buildProjectSeed({ projectRoot: repo, envPatterns: ['.env'] });
    // `control-plane project push` prints these: it captures the default env set
    // rather than a per-box selection, so the user must be able to see exactly
    // which secrets now live on the control box.
    expect(res.envFiles).toEqual(['.env']);
  });

  it('produces byte-identical tars for an unchanged tree (so the hash-skip works)', async () => {
    const repo = await makeRepo();
    const a = await buildProjectSeed({ projectRoot: repo });
    const b = await buildProjectSeed({ projectRoot: repo });
    const tarOf = (r: typeof a) => r.items.find((i) => i.relPath === 'untracked.tar.gz')!.data;
    // Regression: `tar -z` stamps the current time into the gzip header, which
    // gave an unchanged tree a fresh sha256 every run and re-uploaded the
    // largest blob in the seed on every create.
    expect(tarOf(b).equals(tarOf(a))).toBe(true);
    const shaOf = (r: typeof a) => r.manifest.files.find((f) => f.path === 'untracked.tar.gz')!.sha256;
    expect(shaOf(b)).toBe(shaOf(a));
  });

  it('captures nothing but a manifest for a clean tree', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentbox-seed-clean-')));
    scratch.push(dir);
    await execa('git', ['-C', dir, 'init', '-q']);
    const res = await buildProjectSeed({ projectRoot: dir });
    expect(res.items).toEqual([]);
    expect(res.manifest.files).toEqual([]);
  });
});

describe('applyProjectSeed', () => {
  /** A seed source backed by an in-memory map of relPath -> bytes. */
  function source(blobs: Record<string, Buffer>) {
    return { get: (rel: string) => Promise.resolve(blobs[rel] ?? null) };
  }

  it('overlays untracked + env tars onto a clone, and the clone wins on conflicts', async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, 'apps-conflict.txt'), 'SEED VERSION');
    const built = await buildProjectSeed({ projectRoot: repo, envPatterns: ['.env'] });
    const blobs: Record<string, Buffer> = {};
    for (const i of built.items) blobs[i.relPath] = i.data;
    blobs['manifest.json'] = Buffer.from(JSON.stringify(built.manifest), 'utf8');

    // A "fresh clone" that already has one of the seeded paths, committed since.
    const clone = realpathSync(mkdtempSync(join(tmpdir(), 'agentbox-seed-clone-')));
    scratch.push(clone);
    await writeFile(join(clone, 'apps-conflict.txt'), 'CLONE VERSION');

    const res = await applyProjectSeed({ source: source(blobs), dest: clone });

    expect(res?.files).toBe(2); // untracked.tar.gz + env.tar.gz
    expect(res?.repoHeadSha).toBe(built.manifest.repoHeadSha);
    // Seed files the clone lacks are restored...
    expect(await readFile(join(clone, 'scratch-notes.md'), 'utf8')).toBe('local notes');
    expect(await readFile(join(clone, '.env'), 'utf8')).toBe('API_KEY=shh');
    // ...but a path the clone already provides keeps the repo's version: a file
    // committed since the seed was captured must not be reverted to a stale copy.
    expect(await readFile(join(clone, 'apps-conflict.txt'), 'utf8')).toBe('CLONE VERSION');
  });

  it('is a no-op when the project has no seed', async () => {
    const clone = realpathSync(mkdtempSync(join(tmpdir(), 'agentbox-seed-noseed-')));
    scratch.push(clone);
    // No manifest => nothing was ever pushed for this project.
    expect(await applyProjectSeed({ source: source({}), dest: clone })).toBeNull();
  });
});

describe('pushProjectSeedToCustody', () => {
  /** A fake custody surface recording puts, with a settable manifest. */
  function fakeCustody(existing: Record<string, string> = {}) {
    const puts: string[] = [];
    const fetchImpl = (async (url: unknown, init?: { method?: string }) => {
      const u = new URL(String(url));
      if (u.pathname === '/admin/custody') {
        return new Response(
          JSON.stringify({
            entries: Object.entries(existing).map(([path, sha256]) => ({ path, sha256 })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (init?.method === 'PUT') {
        puts.push(decodeURIComponent(u.pathname.slice('/admin/custody/'.length)));
        return new Response(JSON.stringify({ changed: true, sha256: 'x' }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, puts };
  }

  it('uploads the seed under projects/<slug>/seed and writes the manifest last', async () => {
    const repo = await makeRepo();
    const { fetchImpl, puts } = fakeCustody();
    const res = await pushProjectSeedToCustody({
      controlPlaneUrl: 'http://cb.test',
      adminToken: 'admin',
      slug: 'o__r',
      projectRoot: repo,
      envPatterns: ['.env'],
      fetchImpl,
    });
    expect(puts).toContain('projects/o__r/seed/untracked.tar.gz');
    expect(puts).toContain('projects/o__r/seed/env.tar.gz');
    // The manifest must land last: it describes the blobs, so a consumer must
    // never see it before they exist.
    expect(puts[puts.length - 1]).toBe('projects/o__r/seed/manifest.json');
    expect(res.uploaded).toBe(puts.length);
    expect(res.skipped).toBe(0);
  });

  it('skips blobs custody already holds (unchanged tree uploads only the manifest)', async () => {
    const repo = await makeRepo();
    const built = await buildProjectSeed({ projectRoot: repo, envPatterns: ['.env'] });
    // Pre-seed custody with the exact hashes this tree produces.
    const existing: Record<string, string> = {};
    for (const f of built.manifest.files) existing[`projects/o__r/seed/${f.path}`] = f.sha256;

    const { fetchImpl, puts } = fakeCustody(existing);
    const res = await pushProjectSeedToCustody({
      controlPlaneUrl: 'http://cb.test',
      adminToken: 'admin',
      slug: 'o__r',
      projectRoot: repo,
      envPatterns: ['.env'],
      fetchImpl,
    });
    expect(res.skipped).toBe(built.items.length);
    // Only the manifest (whose timestamp always differs) is re-uploaded.
    expect(puts).toEqual(['projects/o__r/seed/manifest.json']);
  });

  it('drops a blob the control box refuses and still pushes the rest', async () => {
    // The PC's cap and the control box's cap are independent settings on
    // different machines, so a tar this side deems fine can still be refused
    // there (an oversized body is dropped at the socket, so it surfaces as a
    // network error, not a 413). That must degrade like the local size gate —
    // partial seed, not a failed push.
    const repo = await makeRepo();
    const puts: string[] = [];
    const fetchImpl = (async (url: unknown, init?: { method?: string }) => {
      const u = new URL(String(url));
      if (u.pathname === '/admin/custody') {
        return new Response(JSON.stringify({ entries: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const path = decodeURIComponent(u.pathname.slice('/admin/custody/'.length));
      if (init?.method === 'PUT') {
        if (path.endsWith('untracked.tar.gz')) throw new TypeError('fetch failed'); // socket reset
        puts.push(path);
        return new Response(JSON.stringify({ changed: true, sha256: 'x' }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const res = await pushProjectSeedToCustody({
      controlPlaneUrl: 'http://cb.test',
      adminToken: 'admin',
      slug: 'o__r',
      projectRoot: repo,
      envPatterns: ['.env'],
      fetchImpl,
    });

    expect(res.dropped).toEqual(['untracked.tar.gz']);
    // The env tar and the manifest still land.
    expect(puts).toContain('projects/o__r/seed/env.tar.gz');
    expect(puts).toContain('projects/o__r/seed/manifest.json');
    // The manifest must not advertise a blob that isn't stored.
    expect(res.manifest.files.map((f) => f.path)).not.toContain('untracked.tar.gz');
    expect(res.manifest.files.map((f) => f.path)).toContain('env.tar.gz');
  });

  it('reports unreachable without tarring anything', async () => {
    const repo = await makeRepo();
    // 203.0.113.0/24 is TEST-NET-3: routable-looking, never answers.
    const t0 = Date.now();
    const res = await pushProjectSeedToCustody({
      controlPlaneUrl: 'https://203.0.113.1',
      adminToken: 'admin',
      slug: 'o__r',
      projectRoot: repo,
      envPatterns: ['.env'],
    });
    // `unreachable`, not a zero-count "success" — the caller must be able to
    // tell that nothing was stored.
    expect(res.unreachable).toBe(true);
    expect(res.uploaded).toBe(0);
    // Repo metadata is still reported (cheap git reads)...
    expect(res.manifest.originUrl).toBe('https://github.com/o/r.git');
    // ...but nothing was built: the probe exists precisely so a down control box
    // doesn't cost a tar of the whole untracked tree.
    expect(res.manifest.files).toEqual([]);
    // Bounded by the probe, not by undici's ~10s connect timeout.
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('re-uploads everything under --force', async () => {
    const repo = await makeRepo();
    const built = await buildProjectSeed({ projectRoot: repo, envPatterns: ['.env'] });
    const existing: Record<string, string> = {};
    for (const f of built.manifest.files) existing[`projects/o__r/seed/${f.path}`] = f.sha256;

    const { fetchImpl } = fakeCustody(existing);
    const res = await pushProjectSeedToCustody({
      controlPlaneUrl: 'http://cb.test',
      adminToken: 'admin',
      slug: 'o__r',
      projectRoot: repo,
      envPatterns: ['.env'],
      force: true,
      fetchImpl,
    });
    expect(res.skipped).toBe(0);
    expect(res.uploaded).toBe(built.items.length + 1);
  });
});
