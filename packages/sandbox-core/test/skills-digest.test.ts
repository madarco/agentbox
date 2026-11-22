import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The stamp reads this machine's id and skills from $HOME; never the real one.
vi.hoisted(() => {
  const base = process.env.TMPDIR ?? '/tmp';
  process.env.HOME = `${base}/skills-digest-home-${String(process.pid)}-${String(Date.now())}`;
});

import { tryGetMachineId } from '@agentbox/config';
import {
  bakeSkillsStamp,
  localSkillsDigest,
  resetSkillsDigestMemo,
  skillsDigest,
  skillsMatchForSkip,
  skillsStaleness,
} from '../src/skills/digest.js';
import { discoverLocalSkills } from '../src/skills/discover.js';
import { variantFingerprint } from '../src/prepared-state.js';

const home = (): string => process.env.HOME!;

function skill(name: string, body = 'Body.\n'): void {
  const dir = join(home(), '.agents', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${body}`);
}

beforeEach(() => {
  mkdirSync(home(), { recursive: true });
  resetSkillsDigestMemo();
});
afterEach(() => resetSkillsDigestMemo());

describe('skills digest', () => {
  it('is order-independent and empty for no skills', () => {
    const a = { name: 'a', treeSha: '1'.repeat(64) };
    const b = { name: 'b', treeSha: '2'.repeat(64) };
    expect(skillsDigest([a, b])).toBe(skillsDigest([b, a]));
    expect(skillsDigest([])).toBe('');
  });

  it('counts only the skills the seed would upload, and changes when one is added', async () => {
    const h = join(tmpdir(), `skdg-${String(Date.now())}`);
    mkdirSync(join(h, '.agents', 'skills', 'clean'), { recursive: true });
    writeFileSync(
      join(h, '.agents/skills/clean/SKILL.md'),
      '---\nname: clean\ndescription: d\n---\nx\n',
    );
    const one = await localSkillsDigest({ home: h });
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    // A flagged skill doesn't count: the library would never hold it.
    mkdirSync(join(h, '.agents/skills/leaky'), { recursive: true });
    writeFileSync(
      join(h, '.agents/skills/leaky/SKILL.md'),
      `---\nname: leaky\ndescription: d\n---\nkey: ${'AKIA'}Q7RTX2ZPLM4WNB8D\n`,
    );
    resetSkillsDigestMemo();
    expect(await localSkillsDigest({ home: h })).toBe(one);
    const [clean] = await discoverLocalSkills({ home: h });
    expect(one).toBe(skillsDigest([{ name: 'clean', treeSha: clean!.treeSha }]));
  });

  it('is never folded into the build-context fingerprint (bake sharing compares that)', () => {
    const base = 'a'.repeat(64);
    expect(variantFingerprint(base, {})).toBe(base);
  });
});

describe('bake stamp, skip-fast and staleness', () => {
  it('stamps the digest and this machine, and judges only its own records', async () => {
    skill('one');
    const stamp = await bakeSkillsStamp();
    expect(stamp).toMatchObject({ skillsHost: tryGetMachineId() });
    const entry = { ...stamp };

    expect(skillsMatchForSkip(entry, stamp)).toBe(true);
    expect(await skillsStaleness(entry)).toBeNull();

    skill('two');
    resetSkillsDigestMemo();
    const next = await bakeSkillsStamp();
    expect(skillsMatchForSkip(entry, next)).toBe(false);
    expect(await skillsStaleness(entry)).toMatch(/skills changed/);

    // A record from another machine, or from before skills were tracked, is
    // never re-baked or reported stale on this account.
    const foreign = { skillsDigest: 'f'.repeat(64), skillsHost: 'some-other-machine' };
    expect(skillsMatchForSkip(foreign, next)).toBe(true);
    expect(await skillsStaleness(foreign)).toBeNull();
    expect(skillsMatchForSkip({}, next)).toBe(true);
    expect(await skillsStaleness({})).toBeNull();
    expect(await skillsStaleness(null)).toBeNull();
  });
});
