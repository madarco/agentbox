import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { writeTar } from '@agentbox/sandbox-core';
import {
  MAX_SKILL_VERSIONS,
  approveSkillUpdate,
  importSkill,
  listSkills,
  readMeta,
  setSkillPolicy,
} from '../lib/backend/skills';
import { diffFileSets, diffSkillVersions } from '../lib/backend/skill-diff';
import {
  addFromGit,
  addFromMarketplace,
  discoverRepoSkills,
  gitRunner,
  parseGitSpec,
  refreshSkill,
  resolvePluginLocation,
} from '../lib/backend/skill-sources';
import { boxSkillsStatus, syncSkillBoxes } from '../lib/backend/skill-boxes';
import { memStore } from './_skills-mem-store';

const sha = (c: string) => c.repeat(64);
const meta = (s: string, extra: { linked?: boolean } = {}) => ({
  sha256: s,
  description: 'A skill.',
  size: 10,
  files: 1,
  source: { host: 'mac', path: '/x' },
  ...extra,
});
const body = (t: string) => Readable.from([Buffer.from(t)]);
const gitOrigin = {
  kind: 'git' as const,
  url: 'https://example.com/r.git',
  commit: 'c'.repeat(40),
};

describe('update policy', () => {
  it('holds a new git version as pending and applies it on approval', async () => {
    const store = memStore();
    const first = await importSkill(store, {
      name: 's',
      meta: meta(sha('a')),
      body: body('A'),
      origin: gitOrigin,
    });
    expect(first.held).toBe(false);
    expect(first.skill.policy).toBe('manual');

    const second = await importSkill(store, {
      name: 's',
      meta: meta(sha('b')),
      body: body('B'),
      origin: gitOrigin,
    });
    expect(second.held).toBe(true);
    expect(second.currentChanged).toBe(false);
    const row = (await listSkills(store)).skills[0]!;
    expect(row.current).toBe(sha('a'));
    expect(row.pending?.version).toBe(sha('b'));

    const ap = await approveSkillUpdate(store, 's');
    expect(ap).toMatchObject({ from: sha('a'), to: sha('b') });
    const after = await readMeta(store, 's');
    expect(after?.current).toBe(sha('b'));
    expect(after?.pending).toBeUndefined();
  });

  it('applies at once under auto (uploads and linked folders)', async () => {
    const store = memStore();
    await importSkill(store, {
      name: 's',
      meta: meta(sha('a'), { linked: true }),
      body: body('A'),
    });
    const r = await importSkill(store, {
      name: 's',
      meta: meta(sha('b'), { linked: true }),
      body: body('B'),
    });
    expect(r.held).toBe(false);
    expect(r.currentChanged).toBe(true);
    expect(r.skill.origin).toMatchObject({ kind: 'folder', linked: true, path: '/x' });
    expect(r.skill.policy).toBe('auto');
  });

  it('a policy set by the user survives re-imports from the same kind of source', async () => {
    const store = memStore();
    await importSkill(store, {
      name: 's',
      meta: meta(sha('a')),
      body: body('A'),
      origin: gitOrigin,
    });
    await setSkillPolicy(store, 's', 'auto');
    const r = await importSkill(store, {
      name: 's',
      meta: meta(sha('b')),
      body: body('B'),
      origin: gitOrigin,
    });
    expect(r.held).toBe(false);
    expect(r.skill.policy).toBe('auto');
  });

  it('retention never drops current or pending', async () => {
    const store = memStore();
    await importSkill(store, {
      name: 's',
      meta: meta(sha('0')),
      body: body('0'),
      origin: gitOrigin,
    });
    for (const c of '123456789') {
      await importSkill(store, { name: 's', meta: meta(sha(c)), body: body(c), origin: gitOrigin });
    }
    const m = (await readMeta(store, 's'))!;
    expect(m.current).toBe(sha('0'));
    expect(m.pending).toBe(sha('9'));
    expect(m.versions.length).toBe(MAX_SKILL_VERSIONS + 1);
    expect(store.paths()).toContain(`skills/s/${sha('0')}.tar.gz`);
  });

  it('approve without a pending version is refused', async () => {
    const store = memStore();
    await importSkill(store, { name: 's', meta: meta(sha('a')), body: body('A') });
    await expect(approveSkillUpdate(store, 's')).rejects.toThrow(/no pending update/);
  });
});

describe('git sources', () => {
  it('parses url, fragment path and ref', () => {
    expect(parseGitSpec('owner/repo')).toEqual({ url: 'https://github.com/owner/repo.git' });
    expect(parseGitSpec('owner/repo@v1')).toEqual({
      url: 'https://github.com/owner/repo.git',
      ref: 'v1',
    });
    expect(parseGitSpec('https://h.com/o/r.git#skills/x@main')).toEqual({
      url: 'https://h.com/o/r.git',
      path: 'skills/x',
      ref: 'main',
    });
    expect(parseGitSpec('git@github.com:o/r.git')).toEqual({ url: 'git@github.com:o/r.git' });
    expect(() => parseGitSpec('file:///etc')).toThrow(/unsupported git URL/);
    expect(() => parseGitSpec('o/r#../x')).toThrow(/leaves the repository/);
    expect(() => parseGitSpec('o/r', { ref: '--upload-pack=x' })).toThrow(/invalid git ref/);
  });

  it('resolves marketplace plugin sources', () => {
    const m = {
      metadata: { pluginRoot: './plugins' },
      plugins: [
        { name: 'local', source: './local' },
        { name: 'rooted', source: 'rooted' },
        { name: 'gh', source: { source: 'github', repo: 'o/r' } },
        {
          name: 'sub',
          source: {
            source: 'git-subdir',
            url: 'https://h/x.git',
            path: 'p/q',
            sha: 'f'.repeat(40),
          },
          skills: ['./custom'],
        },
        { name: 'npm', source: { source: 'npm', package: 'x' } },
      ],
    };
    expect(resolvePluginLocation(m, 'local')).toEqual({
      url: null,
      path: 'local',
      skillPaths: ['skills'],
    });
    expect(resolvePluginLocation(m, 'rooted').path).toBe('plugins/rooted');
    expect(resolvePluginLocation(m, 'gh').url).toBe('https://github.com/o/r.git');
    expect(resolvePluginLocation(m, 'sub')).toEqual({
      url: 'https://h/x.git',
      ref: 'f'.repeat(40),
      path: 'p/q',
      skillPaths: ['custom'],
    });
    expect(() => resolvePluginLocation(m, 'npm')).toThrow(/can't fetch/);
    expect(() => resolvePluginLocation(m, 'nope')).toThrow(/no plugin 'nope'/);
  });

  // A real git repo on local disk (file://): no network.
  const tmp = mkdtempSync(join(tmpdir(), 'skills-git-test-'));
  // Inside an AgentBox box `git` on PATH is the box's git shim; use the real one.
  const gitBin = existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';
  const realGit = gitRunner(gitBin);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      gitBin,
      ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd,
        stdio: 'pipe',
      },
    ).toString();
  const skillMd = (name: string, body: string) =>
    `---\nname: ${name}\ndescription: test skill ${name}\n---\n${body}\n`;

  function makeRepo(): string {
    const repo = join(tmp, `repo-${String(Math.random()).slice(2)}`);
    mkdirSync(join(repo, 'skills', 'alpha'), { recursive: true });
    mkdirSync(join(repo, 'skills', 'beta'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', 'one'));
    writeFileSync(join(repo, 'skills', 'beta', 'SKILL.md'), skillMd('beta', 'one'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    return repo;
  }

  it('discovers skills/<name> folders', async () => {
    const repo = makeRepo();
    expect((await discoverRepoSkills(repo)).map((s) => s.relPath)).toEqual([
      'skills/alpha',
      'skills/beta',
    ]);
    expect((await discoverRepoSkills(repo, 'skills/beta')).map((s) => s.name)).toEqual(['beta']);
    await expect(discoverRepoSkills(repo, '../')).rejects.toThrow();
  });

  it('adds, refreshes to pending, and approves', async () => {
    const repo = makeRepo();
    const store = memStore();
    const deps = { store, allowFile: true, git: realGit };
    const url = `file://${repo}`;
    const added = await addFromGit(deps, { url }, { skills: ['alpha'] });
    expect(added.imported.map((i) => i.name)).toEqual(['alpha']);
    expect(added.candidates.map((c) => c.name)).toEqual(['alpha', 'beta']);
    expect(await refreshSkill(deps, 'alpha')).toMatchObject({ status: 'up-to-date' });

    writeFileSync(join(repo, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', 'two'));
    git(repo, 'commit', '-q', '-am', 'edit');
    const r = await refreshSkill(deps, 'alpha');
    expect(r.status).toBe('pending');
    const listed = (await listSkills(store)).skills[0]!;
    expect(listed.pending?.version).toBe(r.to);
    expect(listed.current).toBe(r.from);

    const d = await diffSkillVersions(store, 'alpha');
    expect(d.files).toEqual([
      expect.objectContaining({
        path: 'SKILL.md',
        status: 'modified',
        before: expect.stringContaining('one'),
        after: expect.stringContaining('two'),
      }),
    ]);
    // A second refresh of the same commit doesn't re-pend anything.
    expect((await refreshSkill(deps, 'alpha')).status).toBe('up-to-date');

    await approveSkillUpdate(store, 'alpha');
    expect((await readMeta(store, 'alpha'))?.current).toBe(r.to);
  });

  it('refuses file:// unless allowed', async () => {
    await expect(addFromGit({ store: memStore() }, { url: 'file:///tmp/x' })).rejects.toThrow(
      /unsupported git URL/,
    );
  });

  it('imports only a marketplace plugin’s skills', async () => {
    const repo = join(tmp, 'market');
    mkdirSync(join(repo, '.claude-plugin'), { recursive: true });
    mkdirSync(join(repo, 'plugins', 'p1', 'skills', 'gamma'), { recursive: true });
    mkdirSync(join(repo, 'plugins', 'p2', 'skills', 'delta'), { recursive: true });
    writeFileSync(
      join(repo, 'plugins', 'p1', 'skills', 'gamma', 'SKILL.md'),
      skillMd('gamma', 'g'),
    );
    writeFileSync(
      join(repo, 'plugins', 'p2', 'skills', 'delta', 'SKILL.md'),
      skillMd('delta', 'd'),
    );
    writeFileSync(
      join(repo, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        plugins: [
          { name: 'p1', source: './plugins/p1' },
          { name: 'p2', source: './plugins/p2' },
        ],
      }),
    );
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const store = memStore();
    const res = await addFromMarketplace(
      { store, allowFile: true, git: realGit },
      { marketplace: 'm', url: `file://${repo}`, plugin: 'p1' },
    );
    expect(res.imported.map((i) => i.name)).toEqual(['gamma']);
    expect(res.imported[0]!.skill.origin).toMatchObject({ kind: 'marketplace', plugin: 'p1' });
  });
});

describe('diff', () => {
  it('reports added, removed, modified and mode-only files', () => {
    const f = (path: string, data: string, mode = 0o644) => ({
      path,
      data: Buffer.from(data),
      mode,
    });
    expect(
      diffFileSets(
        [f('a', '1'), f('b', '2'), f('c', '3'), f('d', 'x')],
        [f('a', '1'), f('b', '22'), f('d', 'x', 0o755), f('e', '5')],
      ),
    ).toEqual([
      { path: 'b', status: 'modified', before: '2', after: '22' },
      { path: 'c', status: 'removed', before: '3' },
      { path: 'd', status: 'modified', modeOnly: true },
      { path: 'e', status: 'added', after: '5' },
    ]);
  });

  it('defaults to current -> previous when nothing is pending', async () => {
    const store = memStore();
    const tar = (t: string) =>
      Readable.from([writeTar([{ path: 'SKILL.md', mode: 0o644, data: Buffer.from(t) }])]);
    await importSkill(store, { name: 's', meta: meta(sha('a')), body: tar('one') });
    await importSkill(store, { name: 's', meta: meta(sha('b')), body: tar('two') });
    const d = await diffSkillVersions(store, 's');
    expect(d).toMatchObject({ from: sha('a'), to: sha('b') });
  });
});

describe('box sync', () => {
  async function setup() {
    const store = memStore();
    await importSkill(store, { name: 's', meta: meta(sha('a')), body: body('A') });
    await store.put(
      'boxes/b1/skills.json',
      Buffer.from(JSON.stringify({ at: 't', skills: { s: sha('a') } })),
    );
    await store.put(
      'boxes/b2/skills.json',
      Buffer.from(JSON.stringify({ at: 't', skills: { s: sha('a') } })),
    );
    await importSkill(store, { name: 's', meta: meta(sha('b')), body: body('B') });
    return store;
  }

  it('marks a box behind when its served version is not current', async () => {
    const store = await setup();
    const st = await boxSkillsStatus(store, 'b1');
    expect(st.skills).toEqual([{ name: 's', version: sha('a'), current: sha('b'), behind: true }]);
    expect((await boxSkillsStatus(store, 'none')).skills).toEqual([]);
  });

  it('syncs running boxes that are behind and skips the rest', async () => {
    const store = await setup();
    await store.put(
      'boxes/b3/skills.json',
      Buffer.from(JSON.stringify({ at: 't', skills: { s: sha('b') } })),
    );
    const execs: string[] = [];
    const out = await syncSkillBoxes(
      {
        store,
        boxIds: () => Promise.resolve(['b1', 'b2', 'b3']),
        probeState: (id) => Promise.resolve(id === 'b2' ? 'paused' : 'running'),
        exec: (id, argv) => {
          execs.push(`${id}:${argv.join(' ')}`);
          return Promise.resolve({ exitCode: 0, stdout: 'skills: 1 installed\n', stderr: '' });
        },
        log: () => undefined,
      },
      { names: ['s'] },
    );
    expect(execs).toEqual(['b1:agentbox-ctl skills sync']);
    expect(out).toEqual([
      { boxId: 'b1', status: 'synced', detail: 'skills: 1 installed' },
      { boxId: 'b2', status: 'not-running', detail: 'paused; syncs at its next start' },
    ]);
  });

  it('reports a failed exec without throwing', async () => {
    const store = await setup();
    const out = await syncSkillBoxes(
      {
        store,
        boxIds: () => Promise.resolve([]),
        probeState: () => Promise.resolve('running'),
        exec: () => Promise.reject(new Error('ssh down')),
        log: () => undefined,
      },
      { boxIds: ['b1'] },
    );
    expect(out).toEqual([{ boxId: 'b1', status: 'failed', detail: 'ssh down' }]);
  });
});

describe('skills backend', () => {
  it('lets a loopback caller add a file:// source (validated before the fetch)', async () => {
    const { createSkillsBackend } = await import('../lib/backend/skills-backend');
    const b = createSkillsBackend({
      store: () => memStore(),
      boxIds: () => Promise.resolve([]),
      probeState: () => Promise.resolve('running'),
      exec: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      log: () => undefined,
    });
    // Refused before any git runs when not allowed...
    await expect(b.addSkills({ git: { url: 'file:///nonexistent-p5' } })).rejects.toThrow(
      /unsupported git URL/,
    );
    // ...and reaches git (which then fails on the missing path) when allowed.
    await expect(
      b.addSkills({ git: { url: 'file:///nonexistent-p5' } }, { allowFile: true }),
    ).rejects.toThrow(/git /);
  });
});
