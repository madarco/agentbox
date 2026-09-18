/**
 * The record store seam: a manager's session is opened on one machine while its
 * record may live on another, so the session functions describe what they did
 * and the caller decides where that lands.
 */
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import {
  addWorkspace,
  applyManagerPatch,
  attachBackgroundSession,
  configureManagerStore,
  configureManagerStoreFromConfig,
  detachBackgroundSession,
  fileManagerStore,
  managersFile,
  managerStore,
  newManagerId,
  readManagers,
  remoteManagerStore,
  resolveWorkspaceDir,
  resumeManagerSession,
  startManagerSession,
  stopManagerSession,
  type ManagerExec,
  type ManagerRecord,
} from '../src/workspaces/index.js';

const HOST = 'laptop';

async function makeWorkspace(): Promise<{ id: string; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-mstore-')));
  await mkdir(join(root, '.git'), { recursive: true });
  const ws = await addWorkspace({ host: HOST, root, projects: [] }, { register: async () => {} });
  return { id: ws.id, root };
}

const fakeExec: ManagerExec = async () => ({ exitCode: 0 });
/** `has-session` throwing is how a stopped tmux session reads. */
const noSession: ManagerExec = async (_file, args) => {
  if (args[0] === 'has-session') throw new Error('no session');
  return { exitCode: 0 };
};

function record(over: Partial<ManagerRecord> = {}): ManagerRecord {
  const at = new Date().toISOString();
  return {
    id: newManagerId(),
    workspaceId: 'ws',
    agent: 'claude',
    kind: 'tmux',
    cwd: '/work',
    host: HOST,
    boxIds: [],
    boxJobIds: [],
    createdAt: at,
    lastSeenAt: at,
    ...over,
  };
}

/** Whether a workspace has written a managers.json at all. */
async function managersJson(wsId: string): Promise<string | null> {
  const dir = await resolveWorkspaceDir(wsId);
  if (!dir) return null;
  return readFile(managersFile(dir), 'utf8').catch(() => null);
}

describe('the session functions write nothing', () => {
  it('a start describes the registration, and only the store persists it', async () => {
    const { id, root } = await makeWorkspace();
    const manager = record({ workspaceId: id, cwd: root });
    const registration = await startManagerSession({
      wsId: id,
      manager,
      argv: ['claude'],
      exec: fakeExec,
      hostname: () => HOST,
    });
    expect(registration).toEqual({
      id: manager.id,
      agent: 'claude',
      kind: 'tmux',
      host: HOST,
      cwd: root,
      tmuxSession: `agentbox-manager-${manager.id}`,
      argv: ['claude'],
    });
    expect(await managersJson(id)).toBeNull();
    expect(await readManagers(id)).toEqual([]);

    const stored = await fileManagerStore().registerManager(id, registration);
    expect(stored).toMatchObject({ id: manager.id, kind: 'tmux', host: HOST });
    expect(await readManagers(id)).toEqual([stored]);
  });

  it('a resume describes the same registration, moving the existing record', async () => {
    const { id, root } = await makeWorkspace();
    const rec = record({ workspaceId: id, cwd: root, sessionId: 'sess-1', kind: 'external' });
    const registration = await resumeManagerSession(rec, {
      exec: noSession,
      hostname: () => HOST,
      isPidAlive: () => false,
      now: () => Date.parse(rec.lastSeenAt) + 60 * 60 * 1000,
    });
    expect(registration).toMatchObject({ id: rec.id, kind: 'tmux', host: HOST });
    expect(registration.argv).toEqual(['claude', '--resume', 'sess-1']);
    expect(await managersJson(id)).toBeNull();
  });

  it('a stop and an attach describe a patch', async () => {
    const { id, root } = await makeWorkspace();
    const rec = record({ workspaceId: id, cwd: root });
    const stop = await stopManagerSession(rec, { exec: fakeExec, hostname: () => HOST });
    expect(stop).toMatchObject({ stoppedAt: expect.any(String) });
    const attach = await attachBackgroundSession({
      wsId: id,
      manager: rec,
      backgroundId: '885c3dca',
      exec: noSession,
    });
    expect(attach).toEqual({ tmuxSession: `agentbox-manager-${rec.id}` });
    expect(
      await detachBackgroundSession(
        { ...rec, kind: 'external', tmuxSession: `agentbox-manager-${rec.id}` },
        fakeExec,
      ),
    ).toEqual({ tmuxSession: null });
    expect(await managersJson(id)).toBeNull();
  });
});

describe('applyManagerPatch', () => {
  it('sets a value, unsets on null, and ignores undefined', () => {
    const rec = record({ tmuxSession: 't', lastExit: 1 });
    const next = applyManagerPatch(rec, {
      stoppedAt: '2026-01-01T00:00:00.000Z',
      tmuxSession: null,
      lastExit: undefined,
    });
    expect(next.stoppedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(next).not.toHaveProperty('tmuxSession');
    expect(next.lastExit).toBe(1);
    // The input is untouched: a patch never mutates what it was given.
    expect(rec.tmuxSession).toBe('t');
  });
});

describe('remoteManagerStore', () => {
  it('registers over the control box route and carries the API key', async () => {
    const sent: { url: string; body: unknown; auth: string | null }[] = [];
    const store = remoteManagerStore(
      { url: 'https://box.example/', apiKey: 'KEY' },
      {
        fetchImpl: async (input, init) => {
          const req = init as RequestInit;
          sent.push({
            url: String(input),
            body: req.body ? JSON.parse(String(req.body)) : undefined,
            auth: new Headers(req.headers).get('authorization'),
          });
          return new Response(
            JSON.stringify({
              id: 'aaaaaaaaaaaaaaaa',
              workspaceId: 'ws1',
              agent: 'claude',
              kind: 'tmux',
              cwd: '/work',
              host: HOST,
              hostIsHub: false,
              status: 'running',
              resumable: false,
              workspaceName: 'w',
              taskCounts: { open: 0, done: 0 },
              boxIds: [],
              boxJobIds: [],
              createdAt: 'now',
              lastSeenAt: 'now',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    );
    const rec = await store.registerManager('ws1', {
      agent: 'claude',
      kind: 'tmux',
      host: HOST,
      cwd: '/work',
      tmuxSession: 'agentbox-manager-aaaaaaaaaaaaaaaa',
    });
    expect(sent[0]?.url).toBe('https://box.example/api/v1/workspaces/ws1/managers/register');
    expect(sent[0]?.auth).toBe('Bearer KEY');
    expect(sent[0]?.body).toMatchObject({ kind: 'tmux', host: HOST });
    // The answer is a view; the store hands back a record.
    expect(rec).toMatchObject({ id: 'aaaaaaaaaaaaaaaa', kind: 'tmux' });
    expect(rec).not.toHaveProperty('status');
    expect(rec).not.toHaveProperty('taskCounts');

    await store.reportManager('aaaaaaaaaaaaaaaa', { status: 'running' });
    expect(sent[1]?.url).toBe('https://box.example/api/v1/managers/aaaaaaaaaaaaaaaa/heartbeat');
    expect(sent[1]?.body).toEqual({ status: 'running' });
  });

  it('never writes anything else there, and swallows an unreachable box on a read', async () => {
    const warnings: string[] = [];
    const store = remoteManagerStore(
      { url: 'https://box.example', apiKey: 'KEY' },
      {
        warn: (line) => warnings.push(line),
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    );
    expect(await store.patchManager('ws1', 'id', { title: 't' })).toBeNull();
    expect(await store.removeManagerRecord('ws1', 'id')).toBe(false);
    await expect(
      store.upsertDetectedManager('ws1', {
        agent: 'claude',
        sessionId: 's',
        cwd: '/work',
        host: HOST,
      }),
    ).rejects.toThrow(/holds the workspace/);
    expect(await store.listManagers()).toEqual([]);
    expect(await store.findManager('id')).toBeNull();
    // One line per process, like the timeline sink.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not reach the control box/);
  });
});

describe('configureManagerStoreFromConfig', () => {
  it('is the file store without a control box, and restores it on null', async () => {
    assertTempHome();
    const chosen = await configureManagerStoreFromConfig();
    expect(chosen.kind).toBe('file');
    expect(managerStore()).toBe(chosen);
    const stub = { ...fileManagerStore(), kind: 'remote' as const };
    expect(configureManagerStore(stub).kind).toBe('remote');
    expect(configureManagerStore(null).kind).toBe('file');
  });
});
