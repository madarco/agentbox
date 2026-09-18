import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceAdd } from './_workspace-input';
import { assertTempHome } from '../../../scripts/test-home.js';
import { BACKGROUND_STOP_NOTICE, createManagerBackend } from '../lib/backend/managers';
import { createWorkspaceBackend } from '../lib/backend/workspaces';
import type { BackendDeps } from '../lib/backend/deps';
import { readTimeline } from '@agentbox/relay';

const S1 = '885c3dca-61c2-4f2e-9a70-67063a05aa4d';
const S2 = '0168c88a-7c96-4d63-933b-46bbc38018b9';

interface Harness {
  deps: BackendDeps & { notify: ReturnType<typeof vi.fn> };
  /** tmux sessions by name → the folder each started in. */
  tmux: Map<string, string>;
  alive: Set<number>;
  agents: Record<string, unknown>[];
  ps: string[];
  claudeCalls: number;
  claudeMissing: boolean;
  spawned: string[][];
}

// Every process seam is faked, `claude agents` and `ps` included.
function harness(): Harness {
  const h: Harness = {
    tmux: new Map(),
    alive: new Set(),
    agents: [],
    ps: [],
    claudeCalls: 0,
    claudeMissing: false,
    spawned: [],
    deps: undefined as never,
  };
  h.deps = {
    notify: vi.fn(),
    liveBoxIds: async () => new Set<string>(),
    jobs: async () => [],
    hostname: () => 'laptop',
    isPidAlive: (pid: number) => h.alive.has(pid),
    processStartTime: async () => undefined,
    managerExec: async (file: string, args: string[]) => {
      if (file === 'claude') {
        h.claudeCalls++;
        if (h.claudeMissing)
          throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
        return { exitCode: 0, stdout: JSON.stringify(h.agents) };
      }
      if (file === 'ps') return { exitCode: 0, stdout: h.ps.join('\n') };
      if (args[0] === 'list-sessions') {
        return { exitCode: 0, stdout: [...h.tmux].map(([s, p]) => `${s}\t${p}`).join('\n') };
      }
      h.spawned.push(args);
      if (args[0] === 'new-session') h.tmux.set(args[3]!, args[5]!);
      if (args[0] === 'kill-session') h.tmux.delete(args[2]!.slice(1));
      if (args[0] === 'has-session' && !h.tmux.has(args[2]!.slice(1)))
        throw new Error('no session');
      return { exitCode: 0 };
    },
  };
  return h;
}

function backends(h: Harness) {
  const workspaces = createWorkspaceBackend(h.deps);
  const managers = createManagerBackend(h.deps, {
    workspaceView: (id) => workspaces.getWorkspace(id),
  });
  return { workspaces, managers };
}

async function makeFolder(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-hubbg-')));
  await mkdir(join(root, '.git'), { recursive: true });
  return root;
}

function daemonRow(sessionId: string, cwd: string, id = sessionId.slice(0, 8)) {
  return {
    pid: 1456,
    id,
    cwd,
    kind: 'background',
    sessionId,
    status: 'busy',
    state: 'working',
    name: 'kanban board setup',
  };
}

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox'), { recursive: true, force: true });
});

async function detected(
  h: Harness,
  managers: ReturnType<typeof backends>['managers'],
  root: string,
) {
  h.alive.add(1456);
  const res = await managers.detectManager({
    agent: 'claude',
    sessionId: S1,
    cwd: root,
    pid: 1456,
    host: 'laptop',
  });
  if (!res.ok) throw new Error(res.error);
  return res.manager;
}

describe("a claude manager in Claude's background daemon", () => {
  it('is offered for attach, attaches in a hub session, and a stop leaves the session running', async () => {
    const h = harness();
    const { managers } = backends(h);
    const root = await makeFolder();
    h.agents = [daemonRow(S1, root)];
    const manager = await detected(h, managers, root);
    expect(manager).toMatchObject({
      kind: 'external',
      status: 'running',
      background: { id: '885c3dca', status: 'busy' },
    });
    expect(manager.attachCommand).toBeUndefined();
    // Running while the daemon runs it, whatever the recorded pid says.
    h.alive.delete(1456);
    expect((await managers.getManager(manager.id))?.status).toBe('running');

    const attached = await managers.attachManager(manager.id);
    if (!attached.ok) throw new Error(attached.error);
    const session = `agentbox-manager-${manager.id}`;
    const start = h.spawned.find((a) => a[0] === 'new-session')!;
    expect(start.slice(0, 6)).toEqual(['new-session', '-d', '-s', session, '-c', root]);
    expect(start[9]).toContain("exec 'claude' 'attach' '885c3dca'");
    expect(attached.manager).toMatchObject({
      kind: 'external',
      sessionId: S1,
      status: 'running',
      tmuxSession: session,
      attachCommand: `tmux attach -t =${session}`,
      background: { id: '885c3dca' },
    });
    // The hub's own attach client does not hide the session from the hub.
    h.ps = ['claude attach 885c3dca'];
    expect((await managers.attachManager(manager.id)).ok).toBe(true);
    expect(h.spawned.filter((a) => a[0] === 'new-session')).toHaveLength(1);

    expect(await managers.resumeManager(manager.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('still running as a Claude background session'),
    });
    expect(await managers.removeManager(manager.id)).toMatchObject({ ok: false });

    // The attach client goes with its tmux session.
    h.ps = [];
    const stopped = await managers.stopManager(manager.id);
    if (!stopped.ok) throw new Error(stopped.error);
    expect(stopped.notice).toBe(BACKGROUND_STOP_NOTICE);
    expect(h.spawned.at(-1)).toEqual(['kill-session', '-t', `=${session}`]);
    expect(stopped.manager).toMatchObject({ status: 'running', background: { id: '885c3dca' } });
    expect(stopped.manager.attachCommand).toBeUndefined();
    expect(stopped.manager).not.toHaveProperty('tmuxSession');
    const events = await readTimeline(manager.workspaceId);
    expect(events.map((e) => e.type)).not.toContain('manager.stopped');
  });

  it('is not offered while an AgentBox terminal in its folder or a claude attach client may show it', async () => {
    const h = harness();
    const { managers } = backends(h);
    const root = await makeFolder();
    h.agents = [daemonRow(S1, root)];
    const legacy = 'agentbox-manager-1020d6ffc6aa4e07';
    h.tmux.set(legacy, root);
    const manager = await detected(h, managers, root);
    expect(manager.background).toBeUndefined();
    expect(manager.terminalSession).toBe(legacy);
    expect(await managers.attachManager(manager.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('may already be open'),
    });

    h.tmux.delete(legacy);
    h.ps = ['/Users/dev/.local/bin/claude attach 885c3dca'];
    const view = await managers.listManagers();
    // The snapshot is cached; an attach re-reads it.
    expect(view[0]?.terminalSession).toBe(legacy);
    expect(await managers.attachManager(manager.id)).toMatchObject({ ok: false });
    expect(h.spawned.filter((a) => a[0] === 'new-session')).toEqual([]);
  });

  it('refuses an attach without a running background session', async () => {
    const h = harness();
    const { managers } = backends(h);
    const root = await makeFolder();
    const manager = await detected(h, managers, root);
    expect(manager.background).toBeUndefined();
    expect(await managers.attachManager(manager.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('no running Claude background session'),
    });
  });

  it('never asks claude for a codex manager, and survives a missing claude binary', async () => {
    const h = harness();
    const { managers } = backends(h);
    const root = await makeFolder();
    const codex = await managers.detectManager({
      agent: 'codex',
      sessionId: S2,
      cwd: root,
      host: 'laptop',
    });
    if (!codex.ok) throw new Error(codex.error);
    await managers.listManagers();
    expect(h.claudeCalls).toBe(0);

    h.claudeMissing = true;
    const claude = await detected(h, managers, root);
    expect(claude.background).toBeUndefined();
    expect(claude.status).toBe('running');
  });
});

describe('detect hints a leaked environment can carry', () => {
  it("ignores another folder's manager id, and joins a session-less manager in its own folder", async () => {
    const h = harness();
    const { managers, workspaces } = backends(h);
    const w1 = await makeFolder();
    const w2 = await makeFolder();
    const ws1 = await workspaces.addWorkspace(await workspaceAdd(w1, { host: 'laptop' }));
    if (!ws1.ok) throw new Error(ws1.error);
    const started = await managers.startManager(ws1.workspace.id, { agent: 'claude' });
    if (!started.ok) throw new Error(started.error);
    const hubId = started.manager.id;

    // A daemon session in another folder carries the hub manager's AGENTBOX_MANAGER.
    const leaked = await managers.detectManager({
      agent: 'claude',
      sessionId: S2,
      cwd: w2,
      host: 'laptop',
      managerId: hubId,
    });
    if (!leaked.ok) throw new Error(leaked.error);
    expect(leaked.manager.id).not.toBe(hubId);
    expect(leaked.manager).toMatchObject({ kind: 'external', cwd: w2 });
    expect((await managers.getManager(hubId))?.sessionId).toBeUndefined();

    const own = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: w1,
      host: 'laptop',
      managerId: hubId,
    });
    if (!own.ok) throw new Error(own.error);
    expect(own.manager).toMatchObject({ id: hubId, kind: 'tmux', sessionId: S1 });

    // Once it has a session, only a running hub-run manager is joined by hint.
    await managers.stopManager(hubId);
    const later = await managers.detectManager({
      agent: 'claude',
      sessionId: '11111111-2222-3333-4444-555555555555',
      cwd: w1,
      host: 'laptop',
      managerId: hubId,
    });
    if (!later.ok) throw new Error(later.error);
    expect(later.manager.id).not.toBe(hubId);
  });
});

describe('detect from an AgentBox tmux session', () => {
  it('moves a record home to the session its own manager owns, and adopts nothing else', async () => {
    const h = harness();
    const { managers, workspaces } = backends(h);
    const root = await makeFolder();
    const added = await workspaces.addWorkspace(await workspaceAdd(root, { host: 'laptop' }));
    if (!added.ok) throw new Error(added.error);
    const started = await managers.startManager(added.workspace.id, { agent: 'claude' });
    if (!started.ok) throw new Error(started.error);
    const session = `agentbox-manager-${started.manager.id}`;

    // A session no manager owns is never adopted: the record stays the process
    // the detect reported.
    const orphan = 'agentbox-manager-1020d6ffc6aa4e07';
    h.tmux.set(orphan, root);
    const unowned = await managers.detectManager({
      agent: 'claude',
      sessionId: S2,
      cwd: root,
      host: 'laptop',
      pid: 92033,
      tmuxSession: orphan,
    });
    if (!unowned.ok) throw new Error(unowned.error);
    expect(unowned.manager).toMatchObject({ kind: 'external', pid: 92033 });

    // Its owner's session, started in this folder: the record runs from there now.
    h.tmux.set(session, root);
    const home = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      host: 'laptop',
      pid: 92033,
      tmuxSession: session,
    });
    if (!home.ok) throw new Error(home.error);
    expect(home.manager).toMatchObject({
      id: started.manager.id,
      kind: 'tmux',
      tmuxSession: session,
      status: 'running',
      attachCommand: `tmux attach -t =${session}`,
    });
    expect(home.manager).not.toHaveProperty('pid');

    // Another host's name for a session is never looked up here.
    const remote = await managers.detectManager({
      agent: 'claude',
      sessionId: '22222222-3333-4444-5555-666666666666',
      cwd: root,
      host: 'vps',
      tmuxSession: session,
    });
    if (!remote.ok) throw new Error(remote.error);
    expect(remote.manager.kind).toBe('external');
  });
});
