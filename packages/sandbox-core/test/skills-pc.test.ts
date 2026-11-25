import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentsForSkillDirs,
  compareSkills,
  skillDirOfPath,
  type AgentSkillDirs,
} from '../src/skills/compare.js';
import {
  installCheck,
  installSkillFiles,
  linkDirsForAgents,
  pcSkillsInventory,
  uploadBlocker,
} from '../src/skills/pc.js';
import { treeHash } from '../src/skills/tree.js';

const AGENTS: AgentSkillDirs[] = [
  { id: 'claude', dirs: ['.claude/skills'] },
  { id: 'codex', dirs: ['.codex/skills', '.agents/skills'] },
  { id: 'opencode', dirs: ['.config/opencode/skills', '.claude/skills', '.agents/skills'] },
  { id: 'pi', dirs: ['.pi/agent/skills', '.agents/skills'] },
];

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function writeSkill(root: string, name: string, body = 'Do it.') {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`,
  );
  return dir;
}

describe('compareSkills', () => {
  const l = (name: string, treeSha: string, newestMtimeMs = 0) => ({
    name,
    treeSha,
    newestMtimeMs,
  });
  const h = (name: string, current: string, updatedAt = '2026-01-01T00:00:00Z') => ({
    name,
    current,
    updatedAt,
  });
  it('matches by name into same / differs / local-only / hub-only, sorted', () => {
    const rows = compareSkills(
      [l('b', 'x'), l('a', 'y', Date.parse('2026-02-01')), l('d', 'z')],
      [h('a', 'q'), h('b', 'x'), h('c', 'r')],
    );
    expect(rows.map((r) => [r.name, r.status, r.newer])).toEqual([
      ['a', 'differs', 'local'],
      ['b', 'same', undefined],
      ['c', 'hub-only', undefined],
      ['d', 'local-only', undefined],
    ]);
  });
  it('says the hub is newer when the hub changed last', () => {
    const [r] = compareSkills([l('a', 'y', 1)], [h('a', 'q')]);
    expect(r!.newer).toBe('hub');
  });
  it('names no newer side for a local copy that was not read (no tree hash)', () => {
    const [r] = compareSkills([l('a', '', 0)], [h('a', 'q')]);
    expect(r!.status).toBe('differs');
    expect(r!.newer).toBeUndefined();
  });
});

describe('agents for a skill', () => {
  it('~/.agents/skills is every agent that reads it', () => {
    expect(agentsForSkillDirs(['.agents/skills'], AGENTS)).toEqual(['codex', 'opencode', 'pi']);
    expect(agentsForSkillDirs(['.claude/skills'], AGENTS)).toEqual(['claude', 'opencode']);
    expect(agentsForSkillDirs(['.claude/skills', '.agents/skills'], AGENTS)).toEqual([
      'claude',
      'codex',
      'opencode',
      'pi',
    ]);
  });
  it('maps a source path to its dir, longest match first', () => {
    expect(skillDirOfPath('/Users/m/.agents/skills/x', 'x', AGENTS)).toBe('.agents/skills');
    expect(skillDirOfPath('/home/u/.pi/agent/skills/x/', 'x', AGENTS)).toBe('.pi/agent/skills');
    expect(skillDirOfPath('/Users/m/Projects/x', 'x', AGENTS)).toBeNull();
  });
  it('links only into agents that do not read ~/.agents/skills', () => {
    expect(linkDirsForAgents(AGENTS)).toEqual(['.claude/skills']);
  });
});

describe('pcSkillsInventory', () => {
  it('reports home-relative dirs, agents and tree hashes', async () => {
    const home = tmp('pcinv-');
    const a = writeSkill(join(home, '.agents/skills'), 'shared');
    mkdirSync(join(home, '.claude/skills'), { recursive: true });
    symlinkSync(a, join(home, '.claude/skills/shared'));
    writeSkill(join(home, '.claude/skills'), 'only-claude');
    const inv = await pcSkillsInventory({ home });
    const shared = inv.skills.find((s) => s.name === 'shared')!;
    expect(shared.dirs).toEqual(['.agents/skills', '.claude/skills']);
    expect(shared.agents).toContain('claude');
    expect(shared.agents).toContain('codex');
    expect(shared.treeSha).toMatch(/^[0-9a-f]{64}$/);
    expect(shared.files).toBe(1);
    const oc = inv.skills.find((s) => s.name === 'only-claude')!;
    expect(oc.dirs).toEqual(['.claude/skills']);
    expect(oc.agents).not.toContain('codex');
  });
});

describe('installSkillFiles', () => {
  const files = [
    { path: 'SKILL.md', mode: 0o644, data: Buffer.from('---\nname: s\ndescription: d\n---\n') },
  ];
  const sha = treeHash(files);
  it('installs at ~/.agents/skills and links for claude when claude is set up', async () => {
    const home = tmp('pcinst-');
    mkdirSync(join(home, '.claude'));
    const r = await installSkillFiles('s', files, sha, { home, linkDirs: ['.claude/skills'] });
    expect(r).toMatchObject({ status: 'installed', dir: join(home, '.agents/skills/s') });
    expect(readlinkSync(join(home, '.claude/skills/s'))).toBe(join(home, '.agents/skills/s'));
    expect(await installSkillFiles('s', files, sha, { home, linkDirs: [] })).toMatchObject({
      status: 'unchanged',
    });
  });
  it('links into a nested agent dir only when its parent exists', async () => {
    const home = tmp('pcinst4-');
    mkdirSync(join(home, '.config'));
    const r = await installSkillFiles('s', files, sha, { home, linkDirs: ['.config/foo/skills'] });
    expect(r).not.toHaveProperty('links');
    mkdirSync(join(home, '.config/foo'));
    const r2 = await installSkillFiles('s', files, sha, { home, linkDirs: ['.config/foo/skills'] });
    expect(r2).toMatchObject({ links: [join(home, '.config/foo/skills/s')] });
  });
  it('skips a different copy without overwrite and replaces it with', async () => {
    const home = tmp('pcinst2-');
    writeSkill(join(home, '.agents/skills'), 's', 'mine');
    expect(await installSkillFiles('s', files, sha, { home, linkDirs: [] })).toMatchObject({
      status: 'skipped',
    });
    expect(
      await installSkillFiles('s', files, sha, { home, linkDirs: [], overwrite: true }),
    ).toMatchObject({ status: 'replaced' });
    expect(readFileSync(join(home, '.agents/skills/s/SKILL.md'), 'utf8')).toMatch(/name: s/);
  });
  it('never replaces a local copy it cannot read, even with overwrite', async () => {
    const home = tmp('pcinst5-');
    mkdirSync(join(home, '.agents/skills'), { recursive: true });
    symlinkSync(join(home, 'gone'), join(home, '.agents/skills/s'));
    expect(await installCheck('s', sha, { home, overwrite: true })).toMatchObject({
      action: 'skip',
    });
    expect(
      await installSkillFiles('s', files, sha, { home, linkDirs: [], overwrite: true }),
    ).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/can't be read/) });
  });
  it('installCheck tells install, unchanged and replace apart, with the real path', async () => {
    const home = tmp('pcinst6-');
    const real = tmp('pcinst6-real-');
    mkdirSync(join(home, '.agents'));
    symlinkSync(real, join(home, '.agents/skills'));
    expect(await installCheck('s', sha, { home })).toEqual({
      action: 'install',
      target: join(home, '.agents/skills/s'),
      realTarget: join(realpathSync(real), 's'),
    });
    await installSkillFiles('s', files, sha, { home, linkDirs: [] });
    expect((await installCheck('s', sha, { home })).action).toBe('unchanged');
    expect((await installCheck('s', 'b'.repeat(64), { home, overwrite: true })).action).toBe(
      'replace',
    );
    expect((await installCheck('s', 'b'.repeat(64), { home })).action).toBe('skip');
  });
  it('refuses files that do not hash to the named version', async () => {
    await expect(
      installSkillFiles('s', files, 'a'.repeat(64), { home: tmp('pcinst3-'), linkDirs: [] }),
    ).rejects.toThrow(/hash to/);
  });
});

describe('uploadBlocker', () => {
  it('refuses problems always and findings unless allowed', () => {
    expect(uploadBlocker({ problems: ['bad'], findings: [] })).toBe('bad');
    const f = { problems: [], findings: [{ rule: 'aws', path: 'a', line: 1 }] } as never;
    expect(uploadBlocker(f)).toMatch(/secret scan: aws in a:1/);
    expect(uploadBlocker(f, { allowFindings: true })).toBeNull();
  });
});
