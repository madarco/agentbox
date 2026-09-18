import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import {
  addWorkspace,
  attachBackgroundSession,
  backgroundFor,
  buildManagerShellScript,
  createBackgroundSessionLookup,
  detachBackgroundSession,
  isLiveBackgroundSession,
  parseBackgroundSessions,
  readManagers,
  terminalSessionFor,
  toManagerView,
  upsertDetectedManager,
  type BackgroundSessionSnapshot,
  type ManagerExec,
  type ManagerRecord,
} from '../src/workspaces/index.js';

const noRegister = { register: async () => {} };
const S1 = '885c3dca-61c2-4f2e-9a70-67063a05aa4d';

/** Rows as claude 2.1.270 prints them: a busy session, a stopped one, a failed one, an interactive one. */
const AGENTS_JSON = JSON.stringify([
  {
    pid: 1456,
    id: '885c3dca',
    cwd: '/work',
    kind: 'background',
    sessionId: S1,
    name: 'kanban board setup',
    status: 'busy',
    state: 'working',
  },
  {
    id: 'cd8aa06f',
    cwd: '/work',
    kind: 'background',
    sessionId: 'cd8aa06f-4c6d-42fa-9341-71872eb7d6bc',
    state: 'done',
  },
  { id: 'c8c91167', kind: 'background', sessionId: 'c8c91167-936b', state: 'failed' },
  { pid: 29818, kind: 'interactive', sessionId: '5edc0ee0-ce9a-4e30-962d-bc630388d8bc' },
]);

function record(over: Partial<ManagerRecord> = {}): ManagerRecord {
  const at = new Date().toISOString();
  return {
    id: '0123456789abcdef',
    workspaceId: 'ws',
    agent: 'claude',
    kind: 'external',
    cwd: '/work',
    host: 'laptop',
    sessionId: S1,
    boxIds: [],
    boxJobIds: [],
    createdAt: at,
    lastSeenAt: at,
    ...over,
  };
}

function snapshot(over: Partial<BackgroundSessionSnapshot> = {}): BackgroundSessionSnapshot {
  return {
    sessions: new Map(
      parseBackgroundSessions(AGENTS_JSON)
        .filter(isLiveBackgroundSession)
        .map((s) => [s.sessionId, s]),
    ),
    managerTmux: [],
    attachClients: new Map(),
    ...over,
  };
}

async function makeWorkspace(): Promise<{ id: string; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-mgrbg-')));
  await mkdir(join(root, '.git'), { recursive: true });
  const rec = await addWorkspace(
    { host: hostname(), root, projects: [{ path: root, name: basename(root) }] },
    noRegister,
  );
  return { id: rec.id, root };
}

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox', 'workspaces'), { recursive: true, force: true });
});

describe('parseBackgroundSessions', () => {
  it('keeps background rows only, and counts a session live only while it has a pid', () => {
    const rows = parseBackgroundSessions(AGENTS_JSON);
    expect(rows.map((r) => r.id)).toEqual(['885c3dca', 'cd8aa06f', 'c8c91167']);
    expect(rows[0]).toMatchObject({ pid: 1456, status: 'busy', state: 'working', cwd: '/work' });
    expect(rows.map(isLiveBackgroundSession)).toEqual([true, false, false]);
    expect(isLiveBackgroundSession({ ...rows[0]!, status: 'completed' })).toBe(false);
    expect(parseBackgroundSessions('not json')).toEqual([]);
    expect(parseBackgroundSessions('{"kind":"background"}')).toEqual([]);
  });
});

describe('createBackgroundSessionLookup', () => {
  function fake(): {
    exec: ManagerExec;
    calls: { file: string; args: string[]; timeout?: number }[];
    fail?: NodeJS.ErrnoException;
    release?: () => void;
    hold: boolean;
  } {
    const state: ReturnType<typeof fake> = {
      calls: [],
      hold: false,
      exec: async (file, args, opts) => {
        state.calls.push({ file, args, ...(opts?.timeout ? { timeout: opts.timeout } : {}) });
        if (file === 'claude') {
          if (state.hold) await new Promise<void>((r) => (state.release = r));
          if (state.fail) throw state.fail;
          return { stdout: AGENTS_JSON };
        }
        if (file === 'tmux') {
          return {
            stdout:
              'agentbox-manager-1020d6ffc6aa4e07\t/work\nscratch\t/work\nagentbox-manager-0123456789abcdef\t/work\n',
          };
        }
        return {
          stdout:
            'zsh\nclaude attach 885c3dca\n/Users/dev/.local/bin/claude attach 885c3dca\nclaude attach cd8aa06f --x\n',
        };
      },
    };
    return state;
  }

  it('reads once per window, shares one read in flight, and re-reads on fresh', async () => {
    const f = fake();
    let clock = 1000;
    const lookup = createBackgroundSessionLookup({ exec: f.exec, now: () => clock, ttlMs: 15_000 });
    f.hold = true;
    const a = lookup();
    const b = lookup();
    await new Promise((r) => setTimeout(r, 0));
    f.release?.();
    const [snapA, snapB] = await Promise.all([a, b]);
    expect(snapA).toBe(snapB);
    f.hold = false;
    expect(f.calls.filter((c) => c.file === 'claude')).toEqual([
      { file: 'claude', args: ['agents', '--json', '--all'], timeout: 3000 },
    ]);
    expect([...snapA.sessions.keys()]).toEqual([S1]);
    expect(snapA.managerTmux.map((t) => t.session)).toEqual([
      'agentbox-manager-1020d6ffc6aa4e07',
      'agentbox-manager-0123456789abcdef',
    ]);
    expect(snapA.attachClients.get('885c3dca')).toBe(2);
    expect(snapA.attachClients.has('cd8aa06f')).toBe(false);

    clock += 14_000;
    await lookup();
    expect(f.calls.filter((c) => c.file === 'claude')).toHaveLength(1);
    await lookup({ fresh: true });
    expect(f.calls.filter((c) => c.file === 'claude')).toHaveLength(2);
    clock += 16_000;
    await lookup();
    expect(f.calls.filter((c) => c.file === 'claude')).toHaveLength(3);
  });

  it('leaves a missing claude alone for a while, and skips ps with no live session', async () => {
    const f = fake();
    let clock = 0;
    f.fail = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const lookup = createBackgroundSessionLookup({
      exec: f.exec,
      now: () => clock,
      ttlMs: 1000,
      missingRetryMs: 60_000,
    });
    const snap = await lookup();
    expect(snap.sessions.size).toBe(0);
    expect(f.calls.some((c) => c.file === 'ps')).toBe(false);
    clock += 5000;
    await lookup({ fresh: true });
    expect(f.calls.filter((c) => c.file === 'claude')).toHaveLength(1);
    // tmux is still read: a terminal session needs no claude.
    expect(f.calls.filter((c) => c.file === 'tmux')).toHaveLength(2);
    clock += 60_000;
    f.fail = undefined;
    expect((await lookup()).sessions.size).toBe(1);
  });
});

describe('backgroundFor', () => {
  it('offers a live session nothing the hub can see shows', () => {
    expect(backgroundFor(record(), snapshot())).toEqual({
      id: '885c3dca',
      status: 'busy',
      state: 'working',
      name: 'kanban board setup',
    });
    expect(backgroundFor(record({ agent: 'codex' }), snapshot())).toBeUndefined();
    expect(backgroundFor(record({ sessionId: 'other' }), snapshot())).toBeUndefined();
  });

  it('holds back a session an AgentBox tmux session in its folder, or an attach client, may show', () => {
    const legacy = { session: 'agentbox-manager-1020d6ffc6aa4e07', path: '/work' };
    expect(backgroundFor(record(), snapshot({ managerTmux: [legacy] }))).toBeUndefined();
    expect(
      backgroundFor(record(), snapshot({ managerTmux: [{ ...legacy, path: '/elsewhere' }] })),
    ).toBeDefined();
    expect(
      backgroundFor(record(), snapshot({ attachClients: new Map([['885c3dca', 1]]) })),
    ).toBeUndefined();
    // The manager's own attach session, and its one client, are the hub's own.
    const own = { session: 'agentbox-manager-0123456789abcdef', path: '/work' };
    const withOwn = snapshot({ managerTmux: [own], attachClients: new Map([['885c3dca', 1]]) });
    expect(backgroundFor(record({ tmuxSession: own.session }), withOwn)).toBeDefined();
    withOwn.attachClients.set('885c3dca', 2);
    expect(backgroundFor(record({ tmuxSession: own.session }), withOwn)).toBeUndefined();
  });

  it('holds back a hub-run manager whose own tmux session is up', () => {
    const legacy = 'agentbox-manager-1020d6ffc6aa4e07';
    const hub = record({ kind: 'tmux', tmuxSession: legacy });
    expect(
      backgroundFor(hub, snapshot({ managerTmux: [{ session: legacy, path: '/work' }] })),
    ).toBeUndefined();
    expect(backgroundFor(hub, snapshot())).toBeDefined();
  });
});

describe('terminalSessionFor', () => {
  it('names the one unclaimed AgentBox session in the folder, and nothing when unsure', () => {
    const a = { session: 'agentbox-manager-1020d6ffc6aa4e07', path: '/work' };
    const b = { session: 'agentbox-manager-aaaaaaaaaaaaaaaa', path: '/work' };
    const own = { session: 'agentbox-manager-0123456789abcdef', path: '/work' };
    const none = new Set<string>();
    expect(terminalSessionFor(record(), snapshot({ managerTmux: [a, own] }), none)).toBe(a.session);
    expect(terminalSessionFor(record(), snapshot({ managerTmux: [a, b] }), none)).toBeUndefined();
    expect(
      terminalSessionFor(record(), snapshot({ managerTmux: [a, b] }), new Set([b.session])),
    ).toBe(a.session);
    expect(
      terminalSessionFor(record({ cwd: '/other' }), snapshot({ managerTmux: [a] }), none),
    ).toBeUndefined();
  });
});

describe('toManagerView with a background session', () => {
  it('attaches through the hub session only while it is up, and says so for no hub-run rule', () => {
    const background = { id: '885c3dca', status: 'busy' };
    const base = { status: 'running' as const, workspaceName: 'w', tasks: [] };
    const up = toManagerView(record({ tmuxSession: 'agentbox-manager-0123456789abcdef' }), {
      ...base,
      background,
      attachSession: 'agentbox-manager-0123456789abcdef',
    });
    expect(up).toMatchObject({
      background,
      attachCommand: 'tmux attach -t =agentbox-manager-0123456789abcdef',
    });
    const down = toManagerView(record({ tmuxSession: 'agentbox-manager-0123456789abcdef' }), {
      ...base,
      background,
      attachSession: null,
    });
    expect(down.attachCommand).toBeUndefined();
    expect(down).not.toHaveProperty('tmuxSession');
    const hub = toManagerView(record({ kind: 'tmux', tmuxSession: 'gone' }), {
      ...base,
      background,
      attachSession: null,
    });
    expect(hub.attachCommand).toBeUndefined();
    expect(
      toManagerView(record(), { ...base, terminalSession: 'agentbox-manager-1020d6ffc6aa4e07' })
        .terminalSession,
    ).toBe('agentbox-manager-1020d6ffc6aa4e07');
  });
});

describe('attachBackgroundSession / detachBackgroundSession', () => {
  function tmuxFake(): { exec: ManagerExec; calls: { args: string[]; env?: NodeJS.ProcessEnv }[] } {
    const sessions = new Set<string>();
    const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const exec: ManagerExec = async (_file, args, opts) => {
      calls.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
      if (args[0] === 'new-session') sessions.add(args[3]!);
      if (args[0] === 'kill-session') sessions.delete(args[2]!.slice(1));
      if (args[0] === 'has-session' && !sessions.has(args[2]!.slice(1))) throw new Error('none');
      return { exitCode: 0 };
    };
    return { exec, calls };
  }

  it('runs claude attach in a hub session without changing what was detected, then only detaches', async () => {
    const { id, root } = await makeWorkspace();
    const { manager } = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 1456,
      host: 'laptop',
    });
    const { exec, calls } = tmuxFake();
    const env = {
      PATH: '/bin',
      CLAUDE_PID: '29818',
      CLAUDECODE: '1',
      TMUX: '/t,1,0',
      SHELL: '/bin/zsh',
    };
    const attached = await attachBackgroundSession({
      wsId: id,
      manager,
      backgroundId: '885c3dca',
      exec,
      env,
    });
    const session = `agentbox-manager-${manager.id}`;
    const start = calls.find((c) => c.args[0] === 'new-session')!;
    expect(start.args.slice(0, 6)).toEqual(['new-session', '-d', '-s', session, '-c', root]);
    expect(start.args[9]).toMatch(
      /^unset CLAUDECODE CLAUDE_PID .*; exec 'claude' 'attach' '885c3dca'$/,
    );
    expect(start.env).not.toHaveProperty('CLAUDE_PID');
    expect(start.env).not.toHaveProperty('TMUX');
    expect(calls.some((c) => c.args.includes('mouse'))).toBe(true);
    expect(attached).toEqual({ tmuxSession: session });

    // Reused while it runs.
    await attachBackgroundSession({
      wsId: id,
      manager: { ...manager, tmuxSession: session },
      backgroundId: '885c3dca',
      exec,
    });
    expect(calls.filter((c) => c.args[0] === 'new-session')).toHaveLength(1);
    await expect(
      attachBackgroundSession({ wsId: id, manager, backgroundId: '--help', exec }),
    ).rejects.toThrow(/not a background session id/);

    const detached = await detachBackgroundSession({ ...manager, tmuxSession: session }, exec);
    expect(calls.at(-1)?.args).toEqual(['kill-session', '-t', `=${session}`]);
    expect(detached).toEqual({ tmuxSession: null });
    // Its own tmux session is the manager's home, so there is nothing to unset.
    expect(await detachBackgroundSession({ ...manager, kind: 'tmux' }, exec)).toBeNull();
  });
});

describe('upsertDetectedManager from an AgentBox tmux session', () => {
  it('records the manager as run from that session, replacing the pid it was observed by', async () => {
    const { id, root } = await makeWorkspace();
    const first = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 1456,
      host: 'laptop',
    });
    expect(first.manager.kind).toBe('external');
    const legacy = `agentbox-manager-${id}`;
    const adopted = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 92033,
      host: 'laptop',
      tmuxSession: legacy,
    });
    expect(adopted.manager).toMatchObject({
      id: first.manager.id,
      kind: 'tmux',
      tmuxSession: legacy,
      sessionId: S1,
    });
    expect(adopted.manager).not.toHaveProperty('pid');
    const fresh = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: 'another-session',
      cwd: root,
      host: 'laptop',
      tmuxSession: 'agentbox-manager-aaaaaaaaaaaaaaaa',
    });
    expect(fresh.manager).toMatchObject({
      kind: 'tmux',
      tmuxSession: 'agentbox-manager-aaaaaaaaaaaaaaaa',
    });
    expect(await readManagers(id)).toHaveLength(2);
  });
});

describe('buildManagerShellScript', () => {
  it('unsets an inherited agent session before exporting its own', () => {
    const script = buildManagerShellScript({
      argv: ['claude'],
      env: { AGENTBOX_WORKSPACE: 'ws1', AGENTBOX_MANAGER: 'm1' },
      exitFile: '/tmp/x.exit',
    });
    expect(script.indexOf('unset ')).toBe(0);
    expect(script.slice(0, script.indexOf(';'))).toContain('CLAUDE_CODE_SESSION_ID');
    expect(script.slice(0, script.indexOf(';'))).not.toContain('TMUX');
    expect(script.indexOf('unset ')).toBeLessThan(script.indexOf("export AGENTBOX_MANAGER='m1'"));
  });
});
