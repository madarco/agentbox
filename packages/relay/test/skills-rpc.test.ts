import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsCustodyStore } from '../src/custody/fs-store.js';
import {
  SKILL_BLOB_CHUNK_BYTES,
  parseSkillSelection,
  resolveBoxSkills,
  runSkillsRpc,
  skillContextForRegistration,
} from '../src/skills-rpc.js';

const sha = (c: string): string => c.repeat(64);

/** A library laid out exactly as the hub's `importSkill` writes it. */
async function library(skills: { name: string; version: string; bytes: Buffer }[]) {
  const store = new FsCustodyStore({ root: mkdtempSync(join(tmpdir(), 'skrpc-')) });
  await store.put('skills/.seeded', Buffer.from('{}'));
  for (const s of skills) {
    await store.put(`skills/${s.name}/${s.version}.tar.gz`, s.bytes);
    await store.put(
      `skills/${s.name}/meta.json`,
      Buffer.from(
        JSON.stringify({
          schema: 1,
          name: s.name,
          description: 'd',
          current: s.version,
          updatedAt: new Date().toISOString(),
          versions: [
            {
              sha256: s.version,
              tarballBytes: s.bytes.length,
              tarballSha256: 'x',
              size: 1,
              files: 1,
              uploadedAt: '',
              source: {},
            },
          ],
        }),
      ),
    );
  }
  return store;
}

const parse = (r: { stdout: string }) => JSON.parse(r.stdout) as Record<string, unknown>;

describe('skill selection', () => {
  it('parses only well-formed names and applies include, exclude and none', () => {
    expect(parseSkillSelection({ include: ['a', 'BAD', 3], exclude: ['b'] })).toEqual({
      include: ['a'],
      exclude: ['b'],
    });
    expect(parseSkillSelection({})).toBeUndefined();
    expect(parseSkillSelection('nope')).toBeUndefined();
  });
});

describe('skills.get', () => {
  it('is off without custody or before the first seed', async () => {
    expect(await resolveBoxSkills(null, undefined)).toEqual({ library: false, skills: [] });
    const empty = new FsCustodyStore({ root: mkdtempSync(join(tmpdir(), 'skrpc-')) });
    expect(await resolveBoxSkills(empty, undefined)).toEqual({ library: false, skills: [] });
  });

  it('returns each selected skill at its current version', async () => {
    const store = await library([
      { name: 'one', version: sha('a'), bytes: Buffer.from('tar-one') },
      { name: 'two', version: sha('b'), bytes: Buffer.from('tar-two!') },
    ]);
    expect(await resolveBoxSkills(store, undefined)).toEqual({
      library: true,
      skills: [
        { name: 'one', version: sha('a'), bytes: 7 },
        { name: 'two', version: sha('b'), bytes: 8 },
      ],
    });
    expect(parse(await runSkillsRpc(store, { exclude: ['one'] }, 'skills.get', {}))).toEqual({
      library: true,
      skills: [{ name: 'two', version: sha('b'), bytes: 8 }],
    });
  });
});

describe('skills.blob', () => {
  it('serves a tarball in bounded chunks that reassemble exactly', async () => {
    const big = Buffer.alloc(SKILL_BLOB_CHUNK_BYTES * 2 + 123, 7);
    big[0] = 1;
    big[big.length - 1] = 9;
    const store = await library([{ name: 'big', version: sha('c'), bytes: big }]);
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const r = parse(
        await runSkillsRpc(store, undefined, 'skills.blob', {
          name: 'big',
          version: sha('c'),
          offset,
        }),
      );
      const data = Buffer.from(r.data as string, 'base64');
      expect(data.length).toBeLessThanOrEqual(SKILL_BLOB_CHUNK_BYTES);
      parts.push(data);
      offset += data.length;
      if (r.eof) break;
    }
    expect(Buffer.concat(parts).equals(big)).toBe(true);
    expect(parts).toHaveLength(3);
  });

  it('refuses a skill outside the box set, a wrong version, and bad params', async () => {
    const store = await library([
      { name: 'one', version: sha('a'), bytes: Buffer.from('x') },
      { name: 'two', version: sha('b'), bytes: Buffer.from('y') },
    ]);
    const blob = (sel: Parameters<typeof runSkillsRpc>[1], p: unknown) =>
      runSkillsRpc(store, sel, 'skills.blob', p);
    expect(
      (await blob({ exclude: ['two'] }, { name: 'two', version: sha('b'), offset: 0 })).exitCode,
    ).toBe(1);
    expect((await blob(undefined, { name: 'one', version: sha('f'), offset: 0 })).exitCode).toBe(1);
    expect((await blob(undefined, { name: '../x', version: sha('a'), offset: 0 })).exitCode).toBe(
      1,
    );
    expect((await blob(undefined, { name: 'one', version: sha('a'), offset: -1 })).exitCode).toBe(
      1,
    );
    expect((await blob(undefined, { name: 'one', version: sha('a'), offset: 0 })).exitCode).toBe(0);
  });
});

describe('skill bindings in skills.get (Phase 4)', () => {
  const lib = () =>
    library([
      { name: 'alpha', version: sha('a'), bytes: Buffer.from('A') },
      { name: 'beta', version: sha('b'), bytes: Buffer.from('B') },
    ]);
  const bind = async (store: FsCustodyStore, doc: unknown) =>
    store.put('skills/.bindings.json', Buffer.from(JSON.stringify(doc)));
  const names = (r: { skills: { name: string }[] }) => r.skills.map((s) => s.name);

  it('gives the same repo the same set from two PCs', async () => {
    const store = await lib();
    await bind(store, { project: { 'github.com/acme/app': { alpha: 'exclude' } } });
    const pcA = skillContextForRegistration({
      boxId: 'b1',
      originUrl: 'git@github.com:Acme/App.git',
      originMachineId: '11111111-1111-4111-8111-111111111111',
      originFolder: '/Users/a/code/app',
    });
    const pcB = skillContextForRegistration({
      boxId: 'b2',
      originUrl: 'https://github.com/acme/app',
      originMachineId: '22222222-2222-4222-8222-222222222222',
      originFolder: '/home/b/src/app',
    });
    expect(pcA.projectKey).toBe('github.com/acme/app');
    expect(pcB.projectKey).toBe('github.com/acme/app');
    expect(names(await resolveBoxSkills(store, undefined, pcA))).toEqual(['beta']);
    expect(names(await resolveBoxSkills(store, undefined, pcB))).toEqual(['beta']);
    // Another repo is untouched.
    const other = skillContextForRegistration({
      boxId: 'b3',
      originUrl: 'https://github.com/acme/web',
    });
    expect(names(await resolveBoxSkills(store, undefined, other))).toEqual(['alpha', 'beta']);
  });

  it('applies workspace bindings and only looks the workspace up when one exists', async () => {
    const store = await lib();
    let lookups = 0;
    const inWs = { workspaceId: async () => (lookups++, 'a1b2c3d4e5f60718') };
    expect(names(await resolveBoxSkills(store, undefined, inWs))).toEqual(['alpha', 'beta']);
    expect(lookups).toBe(0);
    await bind(store, {
      global: { alpha: 'exclude' },
      workspace: { a1b2c3d4e5f60718: { alpha: 'include' } },
    });
    expect(names(await resolveBoxSkills(store, undefined, inWs))).toEqual(['alpha', 'beta']);
    expect(lookups).toBe(1);
    const elsewhere = { workspaceId: async () => 'ffffffffffffffff' };
    expect(names(await resolveBoxSkills(store, undefined, elsewhere))).toEqual(['beta']);
    expect(names(await resolveBoxSkills(store, undefined, {}))).toEqual(['beta']);
  });

  it('refuses a blob the bindings excluded', async () => {
    const store = await lib();
    await bind(store, { box: { b1: { alpha: 'exclude' } } });
    const r = await runSkillsRpc(
      store,
      undefined,
      'skills.blob',
      { name: 'alpha', version: sha('a'), offset: 0 },
      { boxId: 'b1' },
    );
    expect(r.exitCode).toBe(1);
    const ok = await runSkillsRpc(
      store,
      undefined,
      'skills.blob',
      { name: 'alpha', version: sha('a'), offset: 0 },
      { boxId: 'b2' },
    );
    expect(ok.exitCode).toBe(0);
  });
});
