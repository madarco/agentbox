import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  lineDiff,
  renderSkillDiff,
  resolveMarketplace,
  skillFoldersAt,
} from '../src/lib/skills/sources.js';

const tmp = mkdtempSync(join(tmpdir(), 'skills-sources-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('resolveMarketplace', () => {
  it('passes URLs through and looks names up in known_marketplaces.json', async () => {
    const home = join(tmp, 'home');
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        gh: { source: { source: 'github', repo: 'o/r' } },
        g: { source: { source: 'git', url: 'https://h/x.git', ref: 'v2' } },
      }),
    );
    expect(await resolveMarketplace('o/r', home)).toEqual({ marketplace: 'o/r', url: 'o/r' });
    expect(await resolveMarketplace('gh', home)).toEqual({ marketplace: 'gh', url: 'o/r' });
    expect(await resolveMarketplace('g', home)).toEqual({
      marketplace: 'g',
      url: 'https://h/x.git',
      ref: 'v2',
    });
    expect(await resolveMarketplace('nope', home)).toBeNull();
  });
});

describe('skillFoldersAt', () => {
  it('finds a skill folder or a folder of skills', async () => {
    const root = join(tmp, 'lib');
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'SKILL.md'), 'x');
    expect(await skillFoldersAt(root)).toEqual([{ name: 'a', dir: join(root, 'a') }]);
    expect(await skillFoldersAt(join(root, 'a'))).toEqual([{ name: 'a', dir: join(root, 'a') }]);
    expect(await skillFoldersAt(join(root, 'missing'))).toEqual([]);
  });
});

describe('diff rendering', () => {
  it('shows changed lines with context', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
    const after = ['1', '2', '3', '4', 'five', '6', '7', '8'].join('\n');
    expect(lineDiff(before, after)).toEqual([' 3', ' 4', '-5', '+five', ' 6', ' 7']);
  });

  it('renders a per-file report', () => {
    const out = renderSkillDiff({
      name: 's',
      from: 'a'.repeat(64),
      to: 'b'.repeat(64),
      files: [
        { path: 'SKILL.md', status: 'modified', before: 'x', after: 'y' },
        { path: 'img.png', status: 'added', binary: true },
      ],
    });
    expect(out).toContain('~ SKILL.md');
    expect(out).toContain('-x');
    expect(out).toContain('+y');
    expect(out).toContain('+ img.png (binary)');
  });
});
