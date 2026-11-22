import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { skillsDigest } from '@agentbox/sandbox-core';
import {
  MAX_SKILL_VERSIONS,
  SEEDED_MARKER,
  SkillsError,
  discardSkill,
  importSkill,
  listSkills,
  openSkillTarball,
  libraryDigest,
  parseImportMeta,
  libraryBlocksAdoption,
  skillNameProblem,
  type SkillsStore,
  type SkillsStoreEntry,
} from '../lib/backend/skills';

/** In-memory stand-in for the custody store, with the same segment-prefix listing. */
function memStore(): SkillsStore & { paths(): string[] } {
  const m = new Map<string, { data: Buffer; updatedAt: string }>();
  const entry = (path: string): SkillsStoreEntry => {
    const v = m.get(path)!;
    return {
      path,
      size: v.data.length,
      sha256: createHash('sha256').update(v.data).digest('hex'),
      updatedAt: v.updatedAt,
    };
  };
  const put = (path: string, data: Buffer) => {
    const before = m.get(path);
    const changed = !before || !before.data.equals(data);
    if (changed) m.set(path, { data, updatedAt: new Date().toISOString() });
    return { ...entry(path), changed };
  };
  return {
    paths: () => [...m.keys()].sort(),
    list: (prefix) =>
      Promise.resolve(
        [...m.keys()]
          .filter((p) => !prefix || p === prefix || p.startsWith(`${prefix}/`))
          .sort()
          .map(entry),
      ),
    get: (path) =>
      Promise.resolve(m.has(path) ? { entry: entry(path), data: m.get(path)!.data } : null),
    put: (path, data) => Promise.resolve(put(path, data)),
    async putStream(path, body, opts) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of body as AsyncIterable<Buffer>) {
        size += c.length;
        if (opts?.maxBytes !== undefined && size > opts.maxBytes) {
          const err = new Error('too large');
          err.name = 'CustodyTooLargeError';
          throw err;
        }
        chunks.push(Buffer.from(c));
      }
      return put(path, Buffer.concat(chunks));
    },
    getStream: (path) =>
      Promise.resolve(
        m.has(path) ? { entry: entry(path), data: Readable.from([m.get(path)!.data]) } : null,
      ),
    delete: (path) => Promise.resolve(m.delete(path)),
  };
}

const sha = (c: string) => c.repeat(64);
const meta = (s: string, extra: Partial<{ description: string }> = {}) => ({
  sha256: s,
  description: extra.description ?? 'A skill.',
  size: 10,
  files: 1,
  source: { host: 'mac', machineId: 'm1', path: '/Users/x/.agents/skills/one' },
});
const body = (text: string) => Readable.from([Buffer.from(text)]);

describe('skill names', () => {
  it('accepts spec names and rejects the rest', () => {
    expect(skillNameProblem('unslop')).toBeNull();
    expect(skillNameProblem('nano-banana-pro')).toBeNull();
    expect(skillNameProblem('Bad')).toMatch(/invalid/);
    expect(skillNameProblem('a/b')).toMatch(/invalid/);
    expect(skillNameProblem('.seeded')).toMatch(/invalid/);
    expect(skillNameProblem('x'.repeat(65))).toMatch(/invalid/);
    expect(skillNameProblem('agentbox-setup')).toMatch(/reserved/);
    expect(skillNameProblem('agentbox')).toMatch(/reserved/);
    expect(skillNameProblem('agentboxer')).toBeNull();
  });
});

describe('parseImportMeta', () => {
  it('keeps known fields and drops junk', () => {
    const m = parseImportMeta({ ...meta(sha('a')), source: { host: 'h', evil: 1 } });
    expect(m.source).toEqual({ host: 'h' });
  });
  it('rejects a missing or malformed tree hash', () => {
    expect(() => parseImportMeta({ ...meta('nothex') })).toThrow(SkillsError);
    expect(() => parseImportMeta({ ...meta(sha('a')), size: -1 })).toThrow(SkillsError);
    expect(() => parseImportMeta(null)).toThrow(SkillsError);
  });
});

describe('skills library over custody', () => {
  it('starts empty and unseeded', async () => {
    expect(await listSkills(memStore())).toEqual({ seeded: false, skills: [] });
  });

  it('imports, lists, and marks the library seeded once', async () => {
    const store = memStore();
    const r = await importSkill(store, { name: 'one', meta: meta(sha('a')), body: body('tar-a') });
    expect(r).toMatchObject({ name: 'one', version: sha('a'), changed: true });
    expect(store.paths()).toEqual([
      SEEDED_MARKER,
      `skills/one/${sha('a')}.tar.gz`,
      'skills/one/meta.json',
    ]);
    const listing = await listSkills(store);
    expect(listing.seeded).toBe(true);
    expect(listing.skills).toEqual([
      expect.objectContaining({
        name: 'one',
        current: sha('a'),
        versions: 1,
        tarballBytes: 5,
        source: expect.objectContaining({ host: 'mac' }),
      }),
    ]);
  });

  it('re-uploading the same version is unchanged', async () => {
    const store = memStore();
    await importSkill(store, { name: 'one', meta: meta(sha('a')), body: body('tar-a') });
    const again = await importSkill(store, {
      name: 'one',
      meta: meta(sha('a')),
      body: body('tar-a'),
    });
    expect(again.changed).toBe(false);
    expect(again.skill.versions).toBe(1);
  });

  it(`keeps the newest ${String(MAX_SKILL_VERSIONS)} versions and deletes older tarballs`, async () => {
    const store = memStore();
    const shas = ['1', '2', '3', '4', '5', '6', '7'].map(sha);
    for (const s of shas) await importSkill(store, { name: 'one', meta: meta(s), body: body(s) });
    const listing = await listSkills(store);
    expect(listing.skills[0]).toMatchObject({ current: shas[6], versions: MAX_SKILL_VERSIONS });
    expect(store.paths().filter((p) => p.endsWith('.tar.gz'))).toHaveLength(MAX_SKILL_VERSIONS);
    expect(store.paths()).not.toContain(`skills/one/${shas[0]}.tar.gz`);
    // An older kept version is still downloadable by id.
    const old = await openSkillTarball(store, 'one', shas[3]);
    expect(old.version).toBe(shas[3]);
  });

  it('opens the current tarball by default and 404s unknown versions', async () => {
    const store = memStore();
    await importSkill(store, { name: 'one', meta: meta(sha('a')), body: body('tar-a') });
    const t = await openSkillTarball(store, 'one');
    const chunks: Buffer[] = [];
    for await (const c of t.data as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('tar-a');
    await expect(openSkillTarball(store, 'one', sha('b'))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(openSkillTarball(store, 'two')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('discards only the named skill and keeps the seeded marker', async () => {
    const store = memStore();
    await importSkill(store, { name: 'foo', meta: meta(sha('a')), body: body('a') });
    await importSkill(store, { name: 'foobar', meta: meta(sha('b')), body: body('b') });
    expect(await discardSkill(store, 'foo')).toEqual({ removed: 2 });
    const listing = await listSkills(store);
    expect(listing.skills.map((s) => s.name)).toEqual(['foobar']);
    await discardSkill(store, 'foobar');
    expect(await listSkills(store)).toEqual({ seeded: true, skills: [] });
    await expect(discardSkill(store, 'foo')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses reserved and malformed names before touching the store', async () => {
    const store = memStore();
    await expect(
      importSkill(store, { name: 'agentbox-setup', meta: meta(sha('a')), body: body('x') }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(store.paths()).toEqual([]);
  });

  it('passes the size cap to the store', async () => {
    const store = memStore();
    await expect(
      importSkill(store, { name: 'one', meta: meta(sha('a')), body: body('123456'), maxBytes: 3 }),
    ).rejects.toMatchObject({ name: 'CustodyTooLargeError' });
    expect(store.paths()).toEqual([]);
  });
});

describe('skills digest + the control-box adoption gate', () => {
  it('matches sandbox-core on the PC side exactly', () => {
    const set = [
      { name: 'zeta', sha: sha('1') },
      { name: 'alpha', sha: sha('2') },
    ];
    expect(libraryDigest(set.map((e) => ({ name: e.name, current: e.sha })))).toBe(
      skillsDigest(set.map((e) => ({ name: e.name, treeSha: e.sha }))),
    );
    expect(libraryDigest([])).toBe('');
  });

  it('declines a shared bake only when a seeded library differs from its skills', async () => {
    const store = memStore();
    // Not seeded, or a record from before skills were tracked: adopt as always.
    expect(await libraryBlocksAdoption(store, 'f'.repeat(64))).toBe(false);
    await importSkill(store, { name: 'one', meta: meta(sha('a')), body: body('a') });
    expect(await libraryBlocksAdoption(store, undefined)).toBe(false);
    const lib = libraryDigest([{ name: 'one', current: sha('a') }]);
    expect(await libraryBlocksAdoption(store, lib)).toBe(false);
    expect(await libraryBlocksAdoption(store, 'f'.repeat(64))).toBe(true);
    expect(await libraryBlocksAdoption(store, '')).toBe(true); // a PC with no skills
    // Emptied library: only a skill-less bake matches.
    await discardSkill(store, 'one');
    expect(await libraryBlocksAdoption(store, '')).toBe(false);
    expect(await libraryBlocksAdoption(store, lib)).toBe(true);
  });
});
