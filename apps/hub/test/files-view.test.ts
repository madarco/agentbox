import { describe, expect, it } from 'vitest';
import type { CustodyEntry } from '../lib/custody-view';
import {
  FILES_GROUP_ORDER,
  buildFilesView,
  matchProjects,
  originKey,
  readProjectSlug,
  type FilesGroup,
} from '../lib/files-view';

function entry(path: string, size = 100, updatedAt = '2026-11-01T00:00:00.000Z'): CustodyEntry {
  return { path, size, sha256: 'a'.repeat(64), mode: 0o600, updatedAt };
}

const group = (groups: FilesGroup[], id: FilesGroup['id']) => groups.find((g) => g.id === id)!;
const ids = (ps: { id: string }[]) => ps.map((p) => p.id);

describe('readProjectSlug', () => {
  it('splits a key-derived slug into host and path', () => {
    expect(readProjectSlug('github.com__acme__web')).toEqual({
      host: 'github.com',
      path: 'acme/web',
    });
    expect(readProjectSlug('gitlab.com__g__sub__repo')).toEqual({
      host: 'gitlab.com',
      path: 'g/sub/repo',
    });
  });
  it('reads a legacy owner__repo slug as a path', () => {
    expect(readProjectSlug('acme__web')).toEqual({ path: 'acme/web' });
  });
  it('drops a lossy slug digest suffix', () => {
    expect(readProjectSlug('github.com__acme__we-b-0123456789abcdef')).toEqual({
      host: 'github.com',
      path: 'acme/we-b',
    });
  });
});

describe('originKey', () => {
  it('reads https, ssh and scp-like remotes, lowercased', () => {
    expect(originKey('https://github.com/Acme/Web.git')).toEqual({
      host: 'github.com',
      path: 'acme/web',
    });
    expect(originKey('ssh://git@github.com/acme/web')).toEqual({
      host: 'github.com',
      path: 'acme/web',
    });
    expect(originKey('git@gitlab.com:acme/web.git')).toEqual({
      host: 'gitlab.com',
      path: 'acme/web',
    });
    expect(originKey('not a url')).toBeNull();
  });
});

describe('matchProjects', () => {
  it('prefers the registered slug, then the origin, then a unique folder name', () => {
    const projects = [
      { id: 'p1', name: 'web', repo: 'web' },
      { id: 'p2', name: 'api', repo: 'api', originUrl: 'git@github.com:Acme/API.git' },
      { id: 'p3', name: 'Tools', repo: 'tools', projectSlug: 'github.com__acme__tools' },
    ];
    expect(ids(matchProjects('github.com__acme__tools', projects))).toEqual(['p3']);
    expect(ids(matchProjects('github.com__acme__api', projects))).toEqual(['p2']);
    expect(ids(matchProjects('github.com__acme__web', projects))).toEqual(['p1']);
    expect(matchProjects('github.com__acme__nope', projects)).toEqual([]);
  });

  it('returns every project that registered the slug', () => {
    const projects = [
      { id: 'a', name: 'web', projectSlug: 'github.com__acme__web' },
      { id: 'b', name: 'web-2', projectSlug: 'github.com__acme__web' },
    ];
    expect(ids(matchProjects('github.com__acme__web', projects))).toEqual(['a', 'b']);
  });

  it('returns every project folder of one repo', () => {
    const folders = [
      { id: 'root', name: 'workspace', originUrl: 'git@github.com:acme/mono.git' },
      { id: 'sub', name: 'express-ready', originUrl: 'git@github.com:acme/mono.git' },
    ];
    expect(ids(matchProjects('github.com__acme__mono', folders))).toEqual(['root', 'sub']);
    const section = buildFilesView([entry('projects/github.com__acme__mono/seed/manifest.json')], {
      projects: folders,
    })[0]!.sections[0]!;
    expect(section.title).toBe('acme/mono');
    expect(section.href).toBeUndefined();
    expect(section.projects?.map((p) => p.name)).toEqual(['workspace', 'express-ready']);
  });

  it('does not match another host with the same owner/repo', () => {
    const projects = [{ id: 'gl', name: 'web', originUrl: 'git@gitlab.com:acme/web.git' }];
    expect(matchProjects('github.com__acme__web', projects)).toEqual([]);
  });

  it('never matches by folder name a project whose origin is another repo', () => {
    const projects = [
      { id: 'alice', name: 'web', repo: 'web', originUrl: 'https://github.com/alice/web' },
    ];
    expect(matchProjects('github.com__bob__web', projects)).toEqual([]);
  });

  it('refuses an ambiguous folder-name match', () => {
    const twins = [
      { id: 'a', name: 'web', repo: 'web' },
      { id: 'b', name: 'web', repo: 'web' },
    ];
    expect(matchProjects('github.com__acme__web', twins)).toEqual([]);
  });
});

describe('buildFilesView', () => {
  it('returns every group in order, empty ones included', () => {
    const groups = buildFilesView([]);
    expect(groups.map((g) => g.id)).toEqual([...FILES_GROUP_ORDER]);
    expect(groups.every((g) => g.count === 0 && g.sections.length === 0)).toBe(true);
  });

  it('puts every custody entry but bookkeeping under a human group, each once', () => {
    const entries = [
      entry('projects/github.com__acme__web/seed/manifest.json'),
      entry('projects/github.com__acme__web/seed/untracked.tar.gz'),
      entry('projects/github.com__acme__web/cp/notes.txt'),
      entry('agents/claude/.credentials.json'),
      entry('agents/claude/accounts/m1/work/.credentials.json'),
      entry('agents/codex/auth.json'),
      entry('skills/.seeded'),
      entry('skills/review/meta.json'),
      entry('skills/review/1.tar.gz'),
      entry('skills/review/2.tar.gz'),
      entry('prepared/hetzner.json'),
      entry('boxes/sb-1/ssh/id_ed25519'),
      entry('boxes/sb-1/ssh/id_ed25519.pub'),
      entry('boxes/gone/skills.json'),
    ];
    const groups = buildFilesView(entries);
    // `skills/.seeded` is the only entry no row shows.
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(entries.length - 1);
    const rowFiles = groups
      .flatMap((g) => g.sections.flatMap((s) => s.rows))
      .reduce((n, r) => n + r.files, 0);
    expect(rowFiles).toBe(entries.length - 1);
  });

  it('groups project files by project and rolls copied files up', () => {
    const groups = buildFilesView(
      [
        entry('projects/github.com__acme__web/seed/untracked.tar.gz', 300),
        entry('projects/github.com__acme__web/cp/a.txt', 10),
        entry('projects/github.com__acme__web/cp/b/c.txt', 20),
        entry('projects/github.com__acme__web/cp-out/out.log', 5),
        entry('projects/github.com__other__lib/seed/manifest.json'),
      ],
      { projects: [{ id: 'proj-web', name: 'Web app', repo: 'web' }] },
    );
    const projects = group(groups, 'projects');
    expect(projects.sections.map((s) => s.title)).toEqual(['other/lib', 'Web app']);
    const web = projects.sections.find((s) => s.key === 'github.com__acme__web')!;
    expect(web.href).toBe('/projects/proj-web');
    expect(web.subtitle).toBe('github.com/acme/web');
    expect(web.rows.map((r) => [r.title, r.files, r.size])).toEqual([
      ['cp/', 2, 30],
      ['cp-out/', 1, 5],
      ['seed/untracked.tar.gz', 1, 300],
    ]);
  });

  it('rolls agent logins up to one row per agent and account, labelled only for this machine', () => {
    const groups = buildFilesView(
      [
        entry('agents/claude/.credentials.json', 50, '2026-11-01T00:00:00.000Z'),
        entry('agents/claude/accounts/m1/work/.credentials.json', 60, '2026-11-02T00:00:00.000Z'),
        entry('agents/claude/accounts/m1/work/extra.json', 5, '2026-11-03T00:00:00.000Z'),
        entry('agents/claude/accounts/m2/work/.credentials.json', 70),
        entry('agents/codex/auth.json'),
      ],
      {
        accounts: [{ agent: 'claude', id: 'work', label: 'Work Max' }],
        machine: 'm1',
        machines: [{ id: 'm2', label: 'Laptop' }],
        boxes: [{ id: 'b1', originMachineId: 'm1', originMachineLabel: 'MacBook' }],
      },
    );
    const agents = group(groups, 'agents');
    expect(agents.sections.map((s) => s.title)).toEqual(['Claude', 'Codex']);
    const claude = agents.sections[0]!;
    expect(claude.rows.map((r) => [r.title, r.detail])).toEqual([
      ['Default', 'Default login'],
      ['work', 'from Laptop'],
      ['Work Max', 'work · from MacBook'],
    ]);
    const mine = claude.rows[2]!;
    expect(mine.files).toBe(2);
    expect(mine.size).toBe(65);
    expect(mine.updatedAt).toBe(Date.parse('2026-11-03T00:00:00.000Z'));
    expect(mine.hint).toBe('.credentials.json, extra.json');
    expect(mine.href).toBe('/settings/subscriptions');
    expect(claude.rows[1]!.href).toBeUndefined();
  });

  it('shows no account label without knowing the machine', () => {
    const groups = buildFilesView([entry('agents/claude/accounts/m1/work/.credentials.json')], {
      accounts: [{ agent: 'claude', id: 'work', label: 'Work Max' }],
    });
    expect(group(groups, 'agents').sections[0]!.rows[0]!.title).toBe('work');
  });

  it('lists skills by name, without bookkeeping files, and links to Skills', () => {
    const groups = buildFilesView([
      entry('skills/.seeded', 25),
      entry('skills/.bindings.json', 40),
      entry('skills/review/meta.json', 10),
      entry('skills/review/1.tar.gz', 100),
      entry('skills/review/2.tar.gz', 200),
    ]);
    const skills = group(groups, 'skills');
    expect([skills.count, skills.size]).toEqual([3, 310]);
    expect(skills.link?.href).toBe('/settings/skills');
    expect(skills.sections[0]!.rows.map((r) => [r.title, r.detail])).toEqual([
      ['review', '2 versions'],
    ]);
  });

  it('counts a skills library of bookkeeping only as empty', () => {
    const skills = group(buildFilesView([entry('skills/.seeded')]), 'skills');
    expect([skills.count, skills.sections.length]).toEqual([0, 0]);
  });

  it('names bakes by provider and merges a box keyed by both ids into one row', () => {
    const groups = buildFilesView(
      [
        entry('prepared/hetzner.json'),
        entry('boxes/sb-1/ssh/id_ed25519', 400),
        entry('boxes/my-box/skills.json', 50),
        entry('boxes/gone/id_ed25519'),
      ],
      { boxes: [{ id: 'my-box', sandboxId: 'sb-1', task: 'Fix the webhooks' }] },
    );
    expect(group(groups, 'prepared').sections[0]!.rows.map((r) => r.title)).toEqual(['hetzner']);
    const rows = group(groups, 'boxes').sections[0]!.rows;
    expect(rows.map((r) => [r.title, r.detail, r.href, r.size])).toEqual([
      ['gone', 'SSH key · box no longer listed', undefined, 100],
      ['my-box', 'Fix the webhooks · SSH key, Served skills', '/boxes/my-box', 450],
    ]);
    expect(rows[1]!.hint).toBe('sb-1');
  });

  it('never carries anything but metadata', () => {
    const json = JSON.stringify(buildFilesView([entry('agents/claude/.credentials.json')]));
    expect(json).not.toContain('sha256');
    expect(json).not.toContain('a'.repeat(64));
  });
});
