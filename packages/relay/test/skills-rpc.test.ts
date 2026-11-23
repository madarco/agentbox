import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsCustodyStore } from '../src/custody/fs-store.js';
import {
  SKILL_BLOB_CHUNK_BYTES,
  boxSkillsRecordPath,
  parseSkillSelection,
  resolveBoxSkills,
  runSkillsRpc,
  selectSkills,
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
    expect(selectSkills(['a', 'b', 'c'], undefined)).toEqual(['a', 'b', 'c']);
    expect(selectSkills(['a', 'b', 'c'], { exclude: ['b'] })).toEqual(['a', 'c']);
    expect(selectSkills(['a', 'b', 'c'], { include: ['c', 'z'] })).toEqual(['c']);
    expect(selectSkills(['a', 'b'], { none: true })).toEqual([]);
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

describe('served-set record (Phase 5)', () => {
  it('records what skills.get served a box, rewriting only on change', async () => {
    const store = await library([{ name: 'a', version: sha('a'), bytes: Buffer.from('A') }]);
    await runSkillsRpc(store, undefined, 'skills.get', {}, { boxId: 'box1', now: new Date(1000) });
    const first = await store.get(boxSkillsRecordPath('box1'));
    expect(JSON.parse(first!.data.toString('utf8'))).toEqual({
      at: new Date(1000).toISOString(),
      skills: { a: sha('a') },
    });
    await runSkillsRpc(store, undefined, 'skills.get', {}, { boxId: 'box1', now: new Date(2000) });
    const again = await store.get(boxSkillsRecordPath('box1'));
    expect(JSON.parse(again!.data.toString('utf8')).at).toBe(new Date(1000).toISOString());
  });

  it('records nothing without a box id or a library', async () => {
    const store = await library([{ name: 'a', version: sha('a'), bytes: Buffer.from('A') }]);
    await runSkillsRpc(store, undefined, 'skills.get', {});
    await runSkillsRpc(store, undefined, 'skills.get', {}, { boxId: '../x' });
    expect(await store.list('boxes')).toEqual([]);
  });
});
