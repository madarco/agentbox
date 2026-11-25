import { describe, expect, it } from 'vitest';
import {
  SKILL_SKIPS_PATH,
  SkillSkipsUnreadableError,
  applySkip,
  emptySkips,
  parseSkips,
  readSkips,
  skippedNames,
} from '../src/skill-skips.js';

function memStore(files: Record<string, string> = {}) {
  const data = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  return {
    get: (p: string) => Promise.resolve(data.has(p) ? { data: data.get(p)! } : null),
  };
}

describe('skill skips', () => {
  it('parses only valid names and tolerates junk', () => {
    const doc = parseSkips({
      schema: 1,
      skipped: { good: { at: '2026-01-01T00:00:00.000Z' }, BAD: {}, other: 'x', __proto__: {} },
    });
    expect(skippedNames(doc)).toEqual(['good', 'other']);
    expect(doc.skipped.other!.at).toBe('');
    expect(skippedNames(parseSkips(null))).toEqual([]);
    expect(skippedNames(parseSkips({ skipped: [] }))).toEqual([]);
  });

  it('skip and unskip are pure, keep the first skip time, and are idempotent', () => {
    const t1 = new Date('2026-01-01T00:00:00Z');
    const a = applySkip(emptySkips(), 'one', true, t1);
    expect(a.skipped.one!.at).toBe(t1.toISOString());
    const b = applySkip(a, 'one', true, new Date('2027-01-01T00:00:00Z'));
    expect(b.skipped.one!.at).toBe(t1.toISOString());
    const c = applySkip(b, 'one', false);
    expect(skippedNames(c)).toEqual([]);
    expect(skippedNames(b)).toEqual(['one']);
  });

  it('a missing file is nothing skipped; a broken one fails closed', async () => {
    expect(skippedNames(await readSkips(memStore()))).toEqual([]);
    const corrupt = memStore({ [SKILL_SKIPS_PATH]: '{nope' });
    await expect(readSkips(corrupt)).rejects.toThrow(SkillSkipsUnreadableError);
    await expect(readSkips(corrupt)).rejects.toThrow(/not valid JSON/);
    for (const body of ['[]', 'null', '{"skipped":[]}', '{"schema":1}']) {
      await expect(readSkips(memStore({ [SKILL_SKIPS_PATH]: body }))).rejects.toThrow(
        /no `skipped` object/,
      );
    }
    const unreadable = { get: () => Promise.reject(new Error('EIO: i/o error')) };
    await expect(readSkips(unreadable)).rejects.toThrow(/can't be read \(EIO: i\/o error\)/);
    const ok = memStore({
      [SKILL_SKIPS_PATH]: JSON.stringify({ schema: 1, skipped: { x: { at: 'now' } } }),
    });
    expect(skippedNames(await readSkips(ok))).toEqual(['x']);
  });
});
