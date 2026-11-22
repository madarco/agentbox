import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SKILLS_DIGEST_ENV,
  bakeSkillsDigest,
  localSkillsDigest,
  resetSkillsDigestMemo,
  skillsDigest,
} from '../src/skills/digest.js';
import { discoverLocalSkills } from '../src/skills/discover.js';
import { variantFingerprint } from '../src/prepared-state.js';

function skill(home: string, name: string, body = 'Body.\n'): void {
  const dir = join(home, '.agents', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${body}`);
}

afterEach(() => {
  delete process.env[SKILLS_DIGEST_ENV];
  resetSkillsDigestMemo();
});

describe('skills digest', () => {
  it('is order-independent and empty for no skills', () => {
    const a = { name: 'a', treeSha: '1'.repeat(64) };
    const b = { name: 'b', treeSha: '2'.repeat(64) };
    expect(skillsDigest([a, b])).toBe(skillsDigest([b, a]));
    expect(skillsDigest([])).toBe('');
  });

  it('counts only the skills the seed would upload, and changes when one is added', async () => {
    const home = mkdtempSync(join(tmpdir(), 'skdg-'));
    expect(await localSkillsDigest({ home })).toBe('');
    skill(home, 'clean');
    resetSkillsDigestMemo();
    const one = await localSkillsDigest({ home });
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    // A flagged skill doesn't count: the library would never hold it.
    skill(home, 'leaky', `key: ${'AKIA'}Q7RTX2ZPLM4WNB8D\n`);
    resetSkillsDigestMemo();
    expect(await localSkillsDigest({ home })).toBe(one);
    const [clean] = await discoverLocalSkills({ home });
    expect(one).toBe(skillsDigest([{ name: 'clean', treeSha: clean!.treeSha }]));
    skill(home, 'second');
    resetSkillsDigestMemo();
    expect(await localSkillsDigest({ home })).not.toBe(one);
  });

  it('the override wins, even when empty', async () => {
    process.env[SKILLS_DIGEST_ENV] = 'f'.repeat(64);
    expect(await bakeSkillsDigest()).toBe('f'.repeat(64));
    process.env[SKILLS_DIGEST_ENV] = '';
    expect(await bakeSkillsDigest()).toBe('');
  });

  it('folds into the fingerprint only when non-empty', () => {
    const base = 'a'.repeat(64);
    expect(variantFingerprint(base, { skills: '' })).toBe(base);
    expect(variantFingerprint(base, {})).toBe(base);
    expect(variantFingerprint(base, { skills: 'b'.repeat(64) })).not.toBe(base);
    expect(variantFingerprint(base, { skills: 'b'.repeat(64) })).not.toBe(
      variantFingerprint(base, { skills: 'c'.repeat(64) }),
    );
  });
});
