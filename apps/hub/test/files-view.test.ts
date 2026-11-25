import { describe, expect, it } from 'vitest';
import type { CustodyEntry } from '../lib/custody-view';
import {
  FILES_GROUP_ORDER,
  buildFilesView,
  matchProject,
  originPath,
  readProjectSlug,
  type FilesGroup,
} from '../lib/files-view';

function entry(path: string, size = 100, updatedAt = '2026-11-01T00:00:00.000Z'): CustodyEntry {
  return { path, size, sha256: 'a'.repeat(64), mode: 0o600, updatedAt };
}

const group = (groups: FilesGroup[], id: FilesGroup['id']) => groups.find((g) => g.id === id)!;

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

describe('originPath', () => {
  it('reads https, ssh and scp-like remotes', () => {
    expect(originPath('https://github.com/acme/web.git')).toBe('acme/web');
    expect(originPath('ssh://git@github.com/acme/web')).toBe('acme/web');
    expect(originPath('git@github.com:acme/web.git')).toBe('acme/web');
    expect(originPath('not a url')).toBeNull();
  });
});

describe('matchProject', () => {
  const projects = [
    { id: 'p1', name: 'web', repo: 'web', originUrl: null, projectSlug: null },
    { id: 'p2', name: 'api', repo: 'api', originUrl: 'git@github.com:acme/api.git' },
    { id: 'p3', name: 'Tools', repo: 'tools', projectSlug: 'github.com__acme__tools' },
  ];
  it('prefers the registered slug, then the origin, then a unique folder name', () => {
    expect(matchProject('github.com__acme__tools', projects)?.id).toBe('p3');
    expect(matchProject('github.com__acme__api', projects)?.id).toBe('p2');
    expect(matchProject('github.com__acme__web', projects)?.id).toBe('p1');
    expect(matchProject('github.com__acme__nope', projects)).toBeNull();
  });
  it('refuses an ambiguous folder-name match', () => {
    const twins = [
      { id: 'a', name: 'web', repo: 'web' },
      { id: 'b', name: 'web', repo: 'web' },
    ];
    expect(matchProject('github.com__acme__web', twins)).toBeNull();
  });
});

describe('buildFilesView', () => {
  it('returns every group in order, empty ones included', () => {
    const groups = buildFilesView([]);
    expect(groups.map((g) => g.id)).toEqual([...FILES_GROUP_ORDER]);
    expect(groups.every((g) => g.count === 0 && g.sections.length === 0)).toBe(true);
  });

  it('puts every custody entry under a human group, and counts each once', () => {
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
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(entries.length);
  });

  it('groups project files by project, joined to the hub project name', () => {
    const groups = buildFilesView(
      [
        entry('projects/github.com__acme__web/seed/untracked.tar.gz', 300),
        entry('projects/github.com__acme__web/cp-out/out.log', 10),
        entry('projects/github.com__other__lib/seed/manifest.json'),
      ],
      { projects: [{ id: 'proj-web', name: 'Web app', repo: 'web' }] },
    );
    const projects = group(groups, 'projects');
    expect(projects.sections.map((s) => s.title)).toEqual(['other/lib', 'Web app']);
    const web = projects.sections.find((s) => s.key === 'github.com__acme__web')!;
    expect(web.href).toBe('/projects/proj-web');
    expect(web.subtitle).toBe('github.com/acme/web');
    expect(web.rows.map((r) => [r.title, r.detail])).toEqual([
      ['cp-out/out.log', 'Copied out'],
      ['seed/untracked.tar.gz', 'Seed'],
    ]);
  });

  it('rolls agent logins up to one row per agent and account, with labels', () => {
    const groups = buildFilesView(
      [
        entry('agents/claude/.credentials.json', 50, '2026-11-01T00:00:00.000Z'),
        entry('agents/claude/accounts/m1/work/.credentials.json', 60, '2026-11-02T00:00:00.000Z'),
        entry('agents/claude/accounts/m1/work/extra.json', 5, '2026-11-03T00:00:00.000Z'),
        entry('agents/codex/auth.json'),
      ],
      {
        accounts: [{ agent: 'claude', id: 'work', label: 'Work Max' }],
        boxes: [{ id: 'b1', originMachineId: 'm1', originMachineLabel: 'MacBook' }],
      },
    );
    const agents = group(groups, 'agents');
    expect(agents.sections.map((s) => s.title)).toEqual(['Claude', 'Codex']);
    const claude = agents.sections[0]!;
    expect(claude.rows.map((r) => r.title)).toEqual(['Default', 'Work Max']);
    const work = claude.rows[1]!;
    expect(work.files).toBe(2);
    expect(work.size).toBe(65);
    expect(work.updatedAt).toBe(Date.parse('2026-11-03T00:00:00.000Z'));
    expect(work.detail).toBe('work · from MacBook');
    expect(work.hint).toBe('.credentials.json, extra.json');
  });

  it('lists skills by name, without the seeded marker, and links to Skills', () => {
    const groups = buildFilesView([
      entry('skills/.seeded', 0),
      entry('skills/review/meta.json', 10),
      entry('skills/review/1.tar.gz', 100),
      entry('skills/review/2.tar.gz', 200),
    ]);
    const skills = group(groups, 'skills');
    expect(skills.count).toBe(4);
    expect(skills.link?.href).toBe('/settings/skills');
    const rows = skills.sections[0]!.rows;
    expect(rows.map((r) => [r.title, r.detail, r.size])).toEqual([['review', '2 versions', 310]]);
  });

  it('names bakes by provider and box keys by box', () => {
    const groups = buildFilesView(
      [
        entry('prepared/hetzner.json'),
        entry('boxes/sb-1/ssh/id_ed25519'),
        entry('boxes/sb-1/skills.json'),
        entry('boxes/gone/ssh/id_ed25519'),
      ],
      { boxes: [{ id: 'my-box', sandboxId: 'sb-1' }] },
    );
    expect(group(groups, 'prepared').sections[0]!.rows.map((r) => r.title)).toEqual(['hetzner']);
    const rows = group(groups, 'boxes').sections[0]!.rows;
    expect(rows.map((r) => [r.title, r.detail, r.href])).toEqual([
      ['gone', 'SSH key · box no longer listed', undefined],
      ['my-box', 'SSH key, Served skills', '/boxes/my-box'],
    ]);
  });

  it('never carries anything but metadata', () => {
    const groups = buildFilesView([entry('agents/claude/.credentials.json')]);
    const json = JSON.stringify(groups);
    expect(json).not.toContain('sha256');
    expect(json).not.toContain('a'.repeat(64));
  });
});
