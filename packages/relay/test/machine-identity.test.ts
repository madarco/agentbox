import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { getMachineId } from '@agentbox/config';
import { ptyDir, writePtyMeta } from '@agentbox/sandbox-core';
import { assertTempHome } from '../../../scripts/test-home.js';
import {
  addWorkspace,
  findWorkspaceContaining,
  ptySessionAnswersHere,
  listWorkspaces,
  managerStatus,
  ranElsewhere,
  readManagers,
  readWorkspace,
  restampWorkspaceHost,
  runsOnThisMachine,
  toManagerView,
  upsertDetectedManager,
  workspaceDir,
  workspaceFile,
  workspaceProjectId,
  type ManagerRecord,
  type WorkspaceRecord,
} from '../src/workspaces/index.js';

const noRegister = { register: async () => {} };
const PC = '11111111-2222-4333-8444-555555555555';
const HERE = hostname();

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox', 'workspaces'), { recursive: true, force: true });
  await rm(ptyDir(), { recursive: true, force: true });
});

/** A v2 record exactly as a build from before machine ids wrote it: keyed by hostname. */
async function legacyRecord(host: string, root: string): Promise<WorkspaceRecord> {
  const rec: WorkspaceRecord = {
    version: 2,
    id: 'abcdefabcdef0123',
    name: 'legacy',
    projects: [{ id: workspaceProjectId(host, `${root}/local`), name: 'local' }],
    hosts: {
      [host]: {
        root,
        projectRoots: { [workspaceProjectId(host, `${root}/local`)]: `${root}/local` },
        seenAt: '2026-01-01T00:00:00.000Z',
      },
    },
    taskCounter: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const dir = workspaceDir(rec.id, root);
  await mkdir(dir, { recursive: true });
  await writeFile(workspaceFile(dir), JSON.stringify(rec));
  return rec;
}

describe('workspace host maps adopt a hostname-keyed entry', () => {
  it("re-keys this machine's own legacy entry under its id on read, and writes it back", async () => {
    const root = join(assertTempHome(), 'legacy');
    await mkdir(join(root, 'local'), { recursive: true });
    const legacy = await legacyRecord(HERE, root);
    const [read] = await listWorkspaces();
    const me = { id: getMachineId(), label: HERE };
    expect(Object.keys(read!.hosts)).toEqual([me.id]);
    expect(read!.hosts[me.id]).toMatchObject({ root, label: HERE });
    // Persisted: the next reader finds the id key on disk.
    const raw = JSON.parse(
      await readFile(workspaceFile(workspaceDir(legacy.id, root)), 'utf8'),
    ) as WorkspaceRecord;
    expect(Object.keys(raw.hosts)).toEqual([me.id]);
    // And a hostname flip no longer loses the folder.
    expect(
      findWorkspaceContaining([read!], join(root, 'local'), { id: me.id, label: 'renamed' }),
    ).not.toBeNull();
  });

  it("leaves another machine's legacy entry alone until that machine speaks", async () => {
    await legacyRecord('desk.lan', '/home/dev/w');
    const [read] = await listWorkspaces();
    expect(Object.keys(read!.hosts)).toEqual(['desk.lan']);
  });

  it("moves a PC's legacy entry when its scan arrives with an id, keeping no-remote project ids", async () => {
    const legacy = await legacyRecord('desk.lan', '/home/dev/w');
    const oldProjectId = legacy.projects[0]!.id;
    const rec = await addWorkspace(
      {
        host: 'desk.lan',
        machineId: PC,
        root: '/home/dev/w',
        projects: [{ path: '/home/dev/w/local' }],
      },
      noRegister,
    );
    expect(rec.id).toBe(legacy.id);
    expect(Object.keys(rec.hosts)).toEqual([PC]);
    expect(rec.hosts[PC]).toMatchObject({ root: '/home/dev/w', label: 'desk.lan' });
    // Tasks filed against the project keep resolving: same id, though the
    // machine is now named by its id rather than its old hostname.
    expect(rec.projects.map((p) => p.id)).toEqual([oldProjectId]);
    expect(rec.hosts[PC]!.projectRoots[oldProjectId]).toBe('/home/dev/w/local');
    expect(rec.taskCounter).toBe(3);
  });

  it('does not adopt a legacy entry named like this machine whose folder is not here', async () => {
    // A PC that happens to share the hub's hostname keeps its mapping.
    await legacyRecord(HERE, '/nowhere/on/this/disk');
    const [read] = await listWorkspaces();
    expect(Object.keys(read!.hosts)).toEqual([HERE]);
  });

  it('keeps an id-keyed entry when a client with no id rescans it', async () => {
    const legacy = await legacyRecord('desk.lan', '/home/dev/w');
    await restampWorkspaceHost(legacy.id, { id: PC, label: 'desk.lan' });
    // An older CLI on the same machine: only its hostname to offer.
    const rec = await addWorkspace(
      { host: 'desk.lan', root: '/home/dev/w', projects: [{ path: '/home/dev/w/local' }] },
      noRegister,
    );
    expect(Object.keys(rec.hosts)).toEqual([PC]);
    expect(rec.hosts[PC]?.label).toBe('desk.lan');
  });

  it("re-keys a PC's entry on its detect (restampWorkspaceHost)", async () => {
    const legacy = await legacyRecord('desk.lan', '/home/dev/w');
    await restampWorkspaceHost(legacy.id, { id: PC, label: 'desk.lan' });
    const rec = await readWorkspace(legacy.id);
    expect(Object.keys(rec!.hosts)).toEqual([PC]);
    expect(rec!.hosts[PC]?.label).toBe('desk.lan');
  });
});

function manager(over: Partial<ManagerRecord> = {}): ManagerRecord {
  const at = new Date().toISOString();
  return {
    id: 'aaaaaaaaaaaaaaaa',
    workspaceId: 'ws',
    agent: 'claude',
    kind: 'external',
    cwd: '/w',
    host: 'mac.local',
    boxIds: [],
    boxJobIds: [],
    createdAt: at,
    lastSeenAt: at,
    ...over,
  };
}

describe('manager locality', () => {
  it('matches by machine id across a hostname flip, and never by a shared hostname', () => {
    const probe = { hostname: () => 'mac-2.local', machineId: () => PC };
    expect(runsOnThisMachine(manager({ machineId: PC }), probe)).toBe(true);
    expect(ranElsewhere(manager({ machineId: PC }), { id: PC, label: 'mac-2.local' })).toBe(false);
    // Same name, different machine.
    expect(
      runsOnThisMachine(manager({ machineId: '99999999-2222-4333-8444-555555555555' }), {
        hostname: () => 'mac.local',
        machineId: () => PC,
      }),
    ).toBe(false);
    // A record from before machine ids: its hostname is all there is.
    expect(runsOnThisMachine(manager(), { hostname: () => 'mac.local', machineId: () => PC })).toBe(
      true,
    );
    expect(runsOnThisMachine(manager(), probe)).toBe(false);
  });

  it('says hostIsHub by id', () => {
    const view = toManagerView(manager({ machineId: PC }), {
      status: 'stopped',
      workspaceName: 'w',
      tasks: [],
      hostname: 'mac-2.local',
      machineId: PC,
    });
    expect(view.hostIsHub).toBe(true);
    expect(view.host).toBe('mac.local');
  });

  it('treats a pty manager whose socket answers in this home as local, whatever its host', async () => {
    const rec = manager({
      kind: 'pty',
      host: 'some-other-name',
      pty: { pid: process.pid, socket: '/tmp/abt-x.sock', runId: 'r'.repeat(32) },
    });
    const probe = {
      hostname: () => 'mac-2.local',
      machineId: () => PC,
      ptyHostAlive: async (socket: string) => socket === '/tmp/abt-x.sock',
    };
    // No meta in this home: the socket proves nothing, and the record is elsewhere.
    expect(await ptySessionAnswersHere(rec, probe)).toBe(false);
    await writePtyMeta({
      v: 1,
      managerId: rec.id,
      workspaceId: 'ws',
      agent: 'claude',
      cwd: '/w',
      socket: '/tmp/abt-x.sock',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: 't',
      runId: 'r'.repeat(32),
      cols: 80,
      rows: 24,
      pinned: false,
      leaseGraceMs: 1000,
    });
    expect(runsOnThisMachine(rec, probe)).toBe(false);
    expect(await ptySessionAnswersHere(rec, probe)).toBe(true);
    expect(await managerStatus(rec, probe)).toBe('running');
  });
});

describe('detect stamps the machine id', () => {
  it('records the id a client sends, and drops it when an id-less client detects the session', async () => {
    const ws = await addWorkspace(
      { host: HERE, machineId: getMachineId(), root: '/work/d', projects: [] },
      noRegister,
    );
    const input = { agent: 'claude' as const, sessionId: 's1', cwd: '/work/d', host: 'pc' };
    const first = await upsertDetectedManager(ws.id, { ...input, machineId: PC });
    expect(first.manager).toMatchObject({ host: 'pc', machineId: PC });
    await upsertDetectedManager(ws.id, input);
    expect((await readManagers(ws.id))[0]).not.toHaveProperty('machineId');
  });
});
