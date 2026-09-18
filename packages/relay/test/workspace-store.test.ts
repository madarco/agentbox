import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashProjectPath } from '@agentbox/config';
import { assertTempHome } from '../../../scripts/test-home.js';
import {
  addWorkspace,
  canonicalWorkspaceRoot,
  findWorkspaceContaining,
  listWorkspaces,
  normalizeRepoUrl,
  readWorkspace,
  removeWorkspace,
  renameWorkspace,
  scanWorkspaceProjects,
  toWorkspaceView,
  upgradeWorkspaceRecord,
  workspaceDir,
  workspaceFile,
  workspaceForBox,
  workspaceProjectId,
  type WorkspaceProjectInput,
  type WorkspaceRecord,
} from '../src/workspaces/index.js';

/** Registering into the real project registry is not what these assert. */
const noRegister = { register: async () => {} };

const HERE = hostname();

// The temp HOME is per FILE, so the registry carries over between tests here.
beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox', 'workspaces'), { recursive: true, force: true });
});

async function makeTree(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-ws-')));
  // A repo whose .git is a FILE (worktree/submodule shape).
  await mkdir(join(root, 'a'), { recursive: true });
  await writeFile(join(root, 'a', '.git'), 'gitdir: /elsewhere\n');
  // A repo with a .git directory.
  await mkdir(join(root, 'b', '.git'), { recursive: true });
  // A project identified by agentbox.yaml alone.
  await mkdir(join(root, 'c'), { recursive: true });
  await writeFile(join(root, 'c', 'agentbox.yaml'), 'services: {}\n');
  // Not projects.
  await mkdir(join(root, 'plain'), { recursive: true });
  await mkdir(join(root, '.hidden', '.git'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg', '.git'), { recursive: true });
  return root;
}

/** What a client posts for a folder: the scan it ran, with each project's origin. */
function scanOf(root: string, names: string[], repo = true): WorkspaceProjectInput[] {
  return names.map((n) => ({
    path: join(root, n),
    name: n,
    ...(repo ? { repoUrl: `git@github.com:acme/${n}.git` } : {}),
  }));
}

function add(
  root: string,
  projects: WorkspaceProjectInput[],
  over: { host?: string; name?: string; id?: string } = {},
): Promise<WorkspaceRecord> {
  return addWorkspace({ host: over.host ?? HERE, root, projects, ...over }, noRegister);
}

describe('scanWorkspaceProjects', () => {
  it('finds depth-1 projects and skips dot-dirs, node_modules and plain folders', async () => {
    const root = await makeTree();
    expect(await scanWorkspaceProjects(root)).toEqual([
      join(root, 'a'),
      join(root, 'b'),
      join(root, 'c'),
    ]);
  });

  it('includes the root itself when the root is a project', async () => {
    const root = await makeTree();
    await mkdir(join(root, '.git'), { recursive: true });
    const found = await scanWorkspaceProjects(root);
    expect(found[0]).toBe(root);
    expect(found).toHaveLength(4);
  });
});

describe('normalizeRepoUrl', () => {
  it('collapses ssh, https and .git spellings of one repo to a single key', () => {
    const key = 'github.com/acme/app';
    for (const url of [
      'git@github.com:acme/app.git',
      'git@github.com:acme/app',
      'https://github.com/acme/app',
      'https://github.com/acme/app.git',
      'https://github.com/acme/app/',
      'ssh://git@github.com/acme/app.git',
      'ssh://git@github.com:22/acme/app',
      'https://user:token@github.com/acme/APP.git',
    ]) {
      expect(normalizeRepoUrl(url), url).toBe(key);
    }
  });

  it('keeps different repos apart, and answers undefined for nothing usable', () => {
    expect(normalizeRepoUrl('git@github.com:acme/other.git')).toBe('github.com/acme/other');
    expect(normalizeRepoUrl('git@gitlab.com:acme/app.git')).toBe('gitlab.com/acme/app');
    expect(normalizeRepoUrl('/srv/repos/app.git')).toBe('/srv/repos/app');
    expect(normalizeRepoUrl('')).toBeUndefined();
    expect(normalizeRepoUrl(undefined)).toBeUndefined();
  });
});

describe('addWorkspace', () => {
  it('keys projects by repo, records this host’s folders, and mints a random id', async () => {
    const root = await makeTree();
    const ws = await add(root, scanOf(root, ['a', 'b', 'c']));
    expect(ws.version).toBe(2);
    expect(ws.id).toMatch(/^[0-9a-f]{16}$/);
    // NOT a hash of the root: the same workspace is a different folder elsewhere.
    expect(ws.id).not.toBe(hashProjectPath(root));
    expect(ws.name).toBe(basename(root));
    expect(ws.projects.map((p) => p.id)).toEqual(
      ['a', 'b', 'c'].map((n) => hashProjectPath(`github.com/acme/${n}`)),
    );
    expect(ws.hosts[HERE]?.root).toBe(root);
    expect(ws.hosts[HERE]?.projectRoots[ws.projects[0]!.id]).toBe(join(root, 'a'));
    expect(ws.taskCounter).toBe(0);
  });

  it('keys a project with no remote by host and folder', async () => {
    const root = await makeTree();
    const ws = await add(root, scanOf(root, ['a'], false));
    expect(ws.projects[0]!.id).toBe(workspaceProjectId(HERE, join(root, 'a')));
    expect(ws.projects[0]!.repoUrl).toBeUndefined();
  });

  it('registers each project folder on this hub, and none from another host', async () => {
    const root = await makeTree();
    const mine: string[] = [];
    const register = { register: async (p: string) => void mine.push(p) };
    await addWorkspace(
      { host: HERE, root, projects: scanOf(root, ['a', 'b']) },
      { ...register, hostname: () => HERE },
    );
    expect(mine).toEqual([join(root, 'a'), join(root, 'b')]);
    mine.length = 0;
    await addWorkspace(
      { host: 'laptop', root: '/elsewhere', projects: [{ path: '/elsewhere/x' }] },
      { ...register, hostname: () => HERE },
    );
    expect(mine).toEqual([]);
  });

  it('is idempotent on (host, root): rescans, keeps createdAt, name and the counter', async () => {
    const root = await makeTree();
    const first = await add(root, scanOf(root, ['a', 'b', 'c']), { name: 'kept' });
    const again = await add(root, scanOf(root, ['a', 'b', 'c', 'd']));
    expect(again.id).toBe(first.id);
    expect(again.name).toBe('kept');
    expect(again.createdAt).toBe(first.createdAt);
    expect(again.projects).toHaveLength(4);
    expect(await listWorkspaces()).toHaveLength(1);
  });

  it('merges a second machine holding the same repos into one record', async () => {
    const root = await makeTree();
    const mine = await add(root, scanOf(root, ['a', 'b']));
    const theirs = await addWorkspace(
      {
        host: 'laptop',
        // Their clone lives somewhere else, and only the https spelling is known there.
        root: '/home/dev/work',
        projects: [{ path: '/home/dev/work/a', repoUrl: 'https://github.com/acme/a' }],
      },
      noRegister,
    );
    expect(theirs.id).toBe(mine.id);
    expect(theirs.hosts[HERE]?.root).toBe(root);
    expect(theirs.hosts['laptop']?.root).toBe('/home/dev/work');
    // `b` is only on this machine, and a scan from another host does not drop it.
    expect(theirs.projects).toHaveLength(2);
    expect(await listWorkspaces()).toHaveLength(1);
  });

  it('targets the record an id names, whatever its folder', async () => {
    const root = await makeTree();
    const first = await add(root, scanOf(root, ['a']));
    const moved = await add('/moved', [], { id: first.id });
    expect(moved.id).toBe(first.id);
    expect(moved.hosts[HERE]?.root).toBe('/moved');
  });

  it('keeps two unrelated folders apart', async () => {
    const one = await makeTree();
    const two = await makeTree();
    await add(one, scanOf(one, ['a'], false));
    await add(two, scanOf(two, ['a'], false));
    expect(await listWorkspaces()).toHaveLength(2);
  });
});

describe('workspace registry', () => {
  it('renames, reads back and removes', async () => {
    const root = await makeTree();
    const ws = await add(root, scanOf(root, ['a']));
    expect((await renameWorkspace(ws.id, 'storefront'))?.name).toBe('storefront');
    expect((await readWorkspace(ws.id))?.name).toBe('storefront');
    expect(await removeWorkspace(ws.id)).toBe(true);
    expect(await readWorkspace(ws.id)).toBeNull();
    expect(await removeWorkspace(ws.id)).toBe(false);
  });

  it('skips a malformed record instead of throwing', async () => {
    const root = await makeTree();
    const good = await add(root, scanOf(root, ['a']));
    const junkDir = join(homedir(), '.agentbox', 'workspaces', '0123456789abcdef-junk');
    await mkdir(junkDir, { recursive: true });
    await writeFile(join(junkDir, 'workspace.json'), '{ not json');
    const all = await listWorkspaces();
    expect(all.map((w) => w.id)).toEqual([good.id]);
  });

  it('the API view drops the counter and answers for the reading host', async () => {
    const root = await makeTree();
    const ws = await add(root, scanOf(root, ['a']));
    const view = toWorkspaceView(ws, HERE);
    expect(view).not.toHaveProperty('taskCounter');
    expect(view.root).toBe(root);
    // A box and the project registry key by folder, so both ids answer.
    expect(view.projectIds).toContain(ws.projects[0]!.id);
    expect(view.projectIds).toContain(hashProjectPath(join(root, 'a')));
    // Read from a machine with no checkout: no root, and no path-hash ids.
    const elsewhere = toWorkspaceView(ws, 'vps');
    expect(elsewhere.root).toBeUndefined();
    expect(elsewhere.projectIds).toEqual([ws.projects[0]!.id]);
  });
});

describe('the v1 upgrade', () => {
  const v1 = {
    id: '0123456789abcdef',
    name: 'work',
    root: '/home/dev/work',
    projectIds: [hashProjectPath('/home/dev/work/app'), hashProjectPath('/home/dev/work/api')],
    taskCounter: 7,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  };
  const registry = [
    {
      hash: hashProjectPath('/home/dev/work/app'),
      originalPath: '/home/dev/work/app',
      originUrl: 'git@github.com:acme/app.git',
    },
    { hash: hashProjectPath('/home/dev/work/api'), originalPath: '/home/dev/work/api' },
  ];

  it('keeps the id and the counter, and maps the folders under this host', () => {
    const up = upgradeWorkspaceRecord(v1, 'pc', registry);
    expect(up.version).toBe(2);
    // The id is what tasks, managers and the timeline are stored under.
    expect(up.id).toBe(v1.id);
    expect(up.taskCounter).toBe(7);
    expect(up.createdAt).toBe(v1.createdAt);
    expect(up.hosts['pc']?.root).toBe('/home/dev/work');
    expect(up.projects.map((p) => p.repoUrl)).toEqual(['git@github.com:acme/app.git', undefined]);
    expect(up.projects[0]!.id).toBe(hashProjectPath('github.com/acme/app'));
    // No remote: keyed by host and folder.
    expect(up.projects[1]!.id).toBe(workspaceProjectId('pc', '/home/dev/work/api'));
    expect(up.hosts['pc']?.projectRoots[up.projects[0]!.id]).toBe('/home/dev/work/app');
  });

  it('drops a project the registry no longer knows (a path hash cannot be inverted)', () => {
    const up = upgradeWorkspaceRecord(v1, 'pc', [registry[0]!]);
    expect(up.projects).toHaveLength(1);
  });

  it('reads a version-less record off disk as v2', async () => {
    const root = await canonicalWorkspaceRoot(join(homedir(), 'legacy'));
    const dir = workspaceDir(v1.id, root);
    await mkdir(dir, { recursive: true });
    await writeFile(workspaceFile(dir), JSON.stringify({ ...v1, root }));
    const read = await readWorkspace(v1.id);
    expect(read?.version).toBe(2);
    expect(read?.hosts[HERE]?.root).toBe(root);
    expect((await listWorkspaces()).map((w) => w.id)).toEqual([v1.id]);
  });
});

describe('findWorkspaceContaining', () => {
  const on = (host: string, root: string): WorkspaceRecord['hosts'] => ({
    [host]: { root, projectRoots: {}, seenAt: '' },
  });
  const records = [
    { hosts: on('pc', '/a/foo') },
    { hosts: on('pc', '/a/foo/inner') },
    { hosts: on('pc', '/a/foobar') },
    { hosts: on('vps', '/a/remote') },
  ];

  it('matches the workspace root itself', () => {
    expect(findWorkspaceContaining(records, '/a/foo', 'pc')?.hosts['pc']?.root).toBe('/a/foo');
  });

  it('prefers the longest (most specific) root', () => {
    expect(findWorkspaceContaining(records, '/a/foo/inner/pkg', 'pc')?.hosts['pc']?.root).toBe(
      '/a/foo/inner',
    );
  });

  it('respects path-segment boundaries', () => {
    expect(findWorkspaceContaining(records, '/a/foobar/x', 'pc')?.hosts['pc']?.root).toBe(
      '/a/foobar',
    );
  });

  it('only matches roots on the host asked for', () => {
    expect(findWorkspaceContaining(records, '/a/remote/x', 'pc')).toBeNull();
    expect(findWorkspaceContaining(records, '/a/remote/x', 'vps')?.hosts['vps']?.root).toBe(
      '/a/remote',
    );
  });

  it('returns null when nothing contains the path', () => {
    expect(findWorkspaceContaining(records, '/b/other', 'pc')).toBeNull();
  });
});

describe('workspaceForBox', () => {
  const ws = {
    id: 'w1',
    projects: [{ repoUrl: 'git@github.com:acme/app.git' }],
    hosts: { pc: { root: '/home/dev/work', projectRoots: {}, seenAt: '' } },
  };
  const other = {
    id: 'w2',
    projects: [{ repoUrl: 'https://github.com/acme/other' }],
    hosts: { pc: { root: '/home/dev/other', projectRoots: {}, seenAt: '' } },
  };
  const records = [ws, other];

  it('matches a host checkout by folder', () => {
    expect(workspaceForBox(records, { host: 'pc', projectRoot: '/home/dev/work/app' })?.id).toBe(
      'w1',
    );
  });

  it('matches by repo whatever the spelling, and wins over the folder', () => {
    expect(workspaceForBox(records, { originUrl: 'https://github.com/acme/app' })?.id).toBe('w1');
    expect(
      workspaceForBox(records, {
        originUrl: 'https://github.com/acme/other.git',
        host: 'pc',
        projectRoot: '/home/dev/work/app',
      })?.id,
    ).toBe('w2');
  });

  it("matches a cloud box whose folder is the box's own /workspace", () => {
    expect(
      workspaceForBox(records, {
        originUrl: 'git@github.com:acme/app.git',
        host: 'box',
        projectRoot: '/workspace',
      })?.id,
    ).toBe('w1');
  });

  it("matches a control box's throwaway clone by its repo", () => {
    expect(
      workspaceForBox(records, {
        originUrl: 'git@github.com:acme/app.git',
        host: 'vps',
        projectRoot: '/tmp/agentbox-hub-worker-abc123/app',
      })?.id,
    ).toBe('w1');
  });

  it('matches one workspace from either machine that has it', () => {
    const shared = [
      {
        id: 'w3',
        projects: [{ repoUrl: 'git@github.com:acme/app.git' }],
        hosts: {
          pc: { root: '/home/dev/work', projectRoots: {}, seenAt: '' },
          vps: { root: '/opt/work', projectRoots: {}, seenAt: '' },
        },
      },
    ];
    expect(workspaceForBox(shared, { host: 'pc', projectRoot: '/home/dev/work/x' })?.id).toBe('w3');
    expect(workspaceForBox(shared, { host: 'vps', projectRoot: '/opt/work/x' })?.id).toBe('w3');
  });

  it('answers null when neither key matches', () => {
    expect(workspaceForBox(records, { originUrl: 'git@github.com:acme/nope.git' })).toBeNull();
    expect(workspaceForBox(records, { host: 'pc', projectRoot: '/somewhere/else' })).toBeNull();
    expect(workspaceForBox(records, {})).toBeNull();
  });
});

describe('canonicalWorkspaceRoot', () => {
  it('strips a trailing slash', async () => {
    const root = await makeTree();
    expect(await canonicalWorkspaceRoot(`${root}/`)).toBe(root);
  });
});
