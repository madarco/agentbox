import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import {
  addWorkspace,
  attachBoxToManager,
  buildManagerArgv,
  buildManagerShellScript,
  detachBoxFromManagers,
  isManagerResumable,
  managerResumeBlock,
  isPidAlive,
  isResumableManagerAgent,
  listResumableHostSessions,
  loginShell,
  MANAGER_ID_RE,
  MANAGER_SEEN_WINDOW_MS,
  managerAttachCommand,
  ManagerConflictError,
  managerIdForTarget,
  managerSessionName,
  managerStatus,
  newManagerId,
  readManagers,
  readReconciledManagers,
  reconcileManagers,
  removeManagerRecord,
  resumeManagerSession,
  RESUMABLE_MANAGER_AGENTS,
  managerStatusFormat,
  startManagerTmuxSession,
  stopManagerSession,
  tmuxAvailable,
  tmuxSessionExists,
  toManagerView,
  upsertDetectedManager,
  fileManagerStore,
  type ManagerExec,
  type ManagerRecord,
  type WorkTask,
} from '../src/workspaces/index.js';

const noRegister = { register: async () => {} };

/**
 * A start as a hub performs it: open the session, then persist what it produced
 * through the store. The two are separate now — the hub that RUNS a session need
 * not be the one that holds its record.
 */
async function startAndRecord(
  input: Parameters<typeof startManagerTmuxSession>[0],
): Promise<ManagerRecord> {
  // The tmux carrier explicitly: `startManagerSession` dispatches, and these
  // assertions are about what tmux is told.
  const registration = await startManagerTmuxSession({ hostname: () => 'laptop', ...input });
  const rec = await fileManagerStore().registerManager(input.wsId, registration);
  if (!rec) throw new Error('the manager was not written');
  return rec;
}

interface Call {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** Records every tmux invocation; `fail` makes the named subcommand throw. */
function fakeExec(fail: string[] = []): { calls: Call[]; exec: ManagerExec } {
  const calls: Call[] = [];
  const exec: ManagerExec = async (file, args, opts) => {
    calls.push({ file, args, env: opts?.env });
    if (fail.includes(args[0] ?? '')) throw new Error(`${args[0] ?? ''} failed`);
    return { exitCode: 0 };
  };
  return { calls, exec };
}

async function makeWorkspace(): Promise<{ id: string; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-mgr-')));
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

describe('session naming', () => {
  it('derives the session from the manager id and attaches by exact name', () => {
    expect(managerSessionName('abc123')).toBe('agentbox-manager-abc123');
    // `=` is tmux exact-match: without it a longer id sharing this prefix matches.
    expect(managerAttachCommand('agentbox-manager-abc123')).toBe(
      'tmux attach -t =agentbox-manager-abc123',
    );
    expect(newManagerId()).toMatch(MANAGER_ID_RE);
  });
});

describe('buildManagerArgv', () => {
  it('uses each resumable agent OWN resume spelling and otherwise runs the bare agent', () => {
    expect(buildManagerArgv('claude')).toEqual(['claude']);
    expect(buildManagerArgv('claude', 's1')).toEqual(['claude', '--resume', 's1']);
    // codex has no --resume flag: resuming is a subcommand.
    expect(buildManagerArgv('codex')).toEqual(['codex']);
    expect(buildManagerArgv('codex', 's1')).toEqual(['codex', 'resume', 's1']);
    // An agent with no verified spelling never gets a guessed one.
    expect(buildManagerArgv('opencode')).toEqual(['opencode']);
    expect(buildManagerArgv('opencode', 's1')).toEqual(['opencode']);
  });

  it('names the agents whose session store and resume argv are verified', () => {
    expect([...RESUMABLE_MANAGER_AGENTS]).toEqual(['claude', 'codex']);
    expect(isResumableManagerAgent('claude')).toBe(true);
    expect(isResumableManagerAgent('codex')).toBe(true);
    expect(isResumableManagerAgent('opencode')).toBe(false);
  });
});

describe('buildManagerShellScript', () => {
  it('exports the env, runs the agent and records its exit code', () => {
    const script = buildManagerShellScript({
      argv: ['claude', '--resume', 'a b'],
      env: { AGENTBOX_WORKSPACE: 'ws1', AGENTBOX_MANAGER: '1' },
      exitFile: '/tmp/ws/manager.exit',
    });
    expect(script).toContain("export AGENTBOX_WORKSPACE='ws1'");
    expect(script).toContain("export AGENTBOX_MANAGER='1'");
    expect(script).toContain("'claude' '--resume' 'a b'");
    expect(script).toContain("> '/tmp/ws/manager.exit'");
    expect(script).toContain('exit $__agentbox_rc');
  });

  it('quotes a single quote in an argument', () => {
    const script = buildManagerShellScript({
      argv: ['claude', "it's"],
      env: {},
      exitFile: '/tmp/x',
    });
    expect(script).toContain(`'it'\\''s'`);
  });
});

describe('loginShell', () => {
  it('prefers $SHELL and falls back per platform', () => {
    expect(loginShell({ SHELL: '/opt/fish' })).toBe('/opt/fish');
    expect(loginShell({})).toBe(process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  });
});

describe('tmux probes', () => {
  it('reports availability and exact session matching', async () => {
    const up = fakeExec();
    expect(await tmuxAvailable(up.exec)).toBe(true);
    expect(await tmuxSessionExists('s', up.exec)).toBe(true);
    expect(up.calls[1]?.args).toEqual(['has-session', '-t', '=s']);
    const down = fakeExec(['-V', 'has-session']);
    expect(await tmuxAvailable(down.exec)).toBe(false);
    expect(await tmuxSessionExists('s', down.exec)).toBe(false);
  });
});

function record(over: Partial<ManagerRecord> = {}): ManagerRecord {
  const at = new Date().toISOString();
  return {
    id: '0123456789abcdef',
    workspaceId: 'ws',
    agent: 'claude',
    kind: 'external',
    cwd: '/work',
    host: 'laptop',
    boxIds: [],
    boxJobIds: [],
    createdAt: at,
    lastSeenAt: at,
    ...over,
  };
}

describe('startManagerTmuxSession', () => {
  it('spawns a detached tmux session named after the manager id, under a login shell', async () => {
    const { id, root } = await makeWorkspace();
    const { calls, exec } = fakeExec();
    const manager = record({ id: newManagerId(), workspaceId: id, cwd: root, kind: 'tmux' });
    const rec = await startAndRecord({
      wsId: id,
      manager,
      argv: ['claude'],
      exec,
      env: { SHELL: '/bin/zsh', TMUX: '/tmp/sock,1,0', TMUX_PANE: '%3' },
    });
    const args = calls[0]!.args;
    expect(calls[0]!.file).toBe('tmux');
    expect(args.slice(0, 7)).toEqual([
      'new-session',
      '-d',
      '-s',
      `agentbox-manager-${manager.id}`,
      '-c',
      root,
      '--',
    ]);
    expect(args.slice(7, 9)).toEqual(['/bin/zsh', '-lc']);
    expect(args[9]).toContain(`export AGENTBOX_WORKSPACE='${id}'`);
    // The id, not a flag: the agent's own `agentbox` calls are attributed to this record.
    expect(args[9]).toContain(`export AGENTBOX_MANAGER='${manager.id}'`);
    expect(args[9]).toContain(`managers/${manager.id}.exit`);
    // A hub started from inside tmux must not make tmux refuse to nest.
    expect(calls[0]!.env).not.toHaveProperty('TMUX');
    expect(calls[0]!.env).not.toHaveProperty('TMUX_PANE');
    // Two clients (the tray pane and a terminal) must not clamp the grid to the
    // smaller one. `window-size` is a window option, so the target carries the
    // `:` that selects the session's current window — a bare session target is
    // rejected with "no such window" and the setting is silently lost.
    expect(calls[1]?.args).toEqual([
      'set-option',
      '-w',
      '-t',
      `=agentbox-manager-${manager.id}:`,
      'window-size',
      'latest',
    ]);
    expect(rec).toMatchObject({ kind: 'tmux', tmuxSession: `agentbox-manager-${manager.id}` });
    expect(await readManagers(id)).toEqual([rec]);
  });

  it('scopes mouse and the footer to the session, never the server', async () => {
    const { id, root } = await makeWorkspace();
    const { calls, exec } = fakeExec();
    const manager = record({ id: newManagerId(), workspaceId: id, cwd: root, kind: 'tmux' });
    await startAndRecord({ wsId: id, manager, argv: ['claude'], exec });
    const target = `=agentbox-manager-${manager.id}:`;
    const sets = calls.slice(2).map((c) => c.args);
    expect(sets.map((a) => a.slice(0, 4))).toEqual(
      ['mouse', 'status', 'status-position', 'status-style', 'status-format[0]'].map((name) => [
        'set-option',
        '-t',
        target,
        name,
      ]),
    );
    expect(sets[0]![4]).toBe('on');
    for (const a of sets) {
      expect(a).not.toContain('-g');
      expect(a).not.toContain('-s');
      expect(a).not.toContain('extended-keys');
    }
    const format = sets[4]![4]!;
    expect(format).toContain(`manager claude · ${manager.id.slice(0, 8)}`);
    expect(format).toContain('#{prefix} d');
    expect(format).not.toContain('#(');
  });

  it('keeps going when tmux refuses an option', async () => {
    const { id, root } = await makeWorkspace();
    const { calls, exec } = fakeExec(['set-option']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = record({ id: newManagerId(), workspaceId: id, cwd: root, kind: 'tmux' });
    const rec = await startAndRecord({ wsId: id, manager, argv: ['claude'], exec });
    expect(calls.filter((c) => c.args[0] === 'set-option')).toHaveLength(6);
    expect(rec.kind).toBe('tmux');
    warn.mockRestore();
  });
});

describe('managerStatusFormat', () => {
  it('names the session and workspace, escaping what tmux would read as a directive', () => {
    const format = managerStatusFormat({
      agent: 'codex',
      shortId: '5edc0ee0',
      workspaceName: 'shop #2',
    });
    expect(format).toContain('manager codex · 5edc0ee0');
    expect(format).toContain(' shop ##2');
    expect(format).toContain('#[align=right]');
    expect(managerStatusFormat({ agent: 'claude', shortId: 'abc' })).not.toContain('undefined');
  });

  it('escapes % too, since tmux runs a status format through strftime', () => {
    const format = managerStatusFormat({
      agent: 'claude',
      shortId: 'abc',
      workspaceName: 'q3-%d-review',
    });
    expect(format).toContain(' q3-%%d-review');
    expect(format).not.toMatch(/[^%]%d/u);
    expect(
      managerStatusFormat({ agent: 'claude', shortId: 'abc', workspaceName: '#1 100%' }),
    ).toContain(' ##1 100%%');
  });

  it('keeps several managers in one workspace', async () => {
    const { id, root } = await makeWorkspace();
    const { exec } = fakeExec();
    for (const agent of ['claude', 'codex']) {
      await startAndRecord({
        wsId: id,
        manager: record({ id: newManagerId(), workspaceId: id, cwd: root, agent, kind: 'tmux' }),
        argv: [agent],
        exec,
      });
    }
    expect((await readManagers(id)).map((m) => m.agent)).toEqual(['claude', 'codex']);
  });
});

describe('managerStatus', () => {
  const host = (): string => 'laptop';

  it('reads a tmux manager from its session, on the machine that runs it', async () => {
    const rec = record({ kind: 'tmux', tmuxSession: 'agentbox-manager-x' });
    expect(await managerStatus(rec, { hostname: host, exec: fakeExec().exec })).toBe('running');
    expect(await managerStatus(rec, { hostname: host, exec: fakeExec(['has-session']).exec })).toBe(
      'stopped',
    );
    // Another machine's tmux server is not this one's: fall back to last-seen.
    const elsewhere = { hostname: () => 'vps', exec: fakeExec(['has-session']).exec };
    expect(await managerStatus(rec, elsewhere)).toBe('running');
  });

  it('probes an external pid only on the machine it came from', async () => {
    const rec = record({ pid: 42, host: 'laptop' });
    expect(await managerStatus(rec, { hostname: host, isPidAlive: () => true })).toBe('running');
    expect(await managerStatus(rec, { hostname: host, isPidAlive: () => false })).toBe('stopped');
    // Another machine's pid says nothing here: fall back to the last-seen window.
    const probe = { hostname: () => 'vps', isPidAlive: () => false };
    expect(await managerStatus(rec, probe)).toBe('running');
  });

  it('reads a reused pid as stopped: same pid, different start time', async () => {
    const rec = record({ pid: 42, host: 'laptop', pidStartedAt: 'Sun Sep 13 10:00:00 2026' });
    const probe = (started: string | undefined) => ({
      hostname: host,
      isPidAlive: () => true,
      processStartTime: async () => started,
    });
    expect(await managerStatus(rec, probe('Sun Sep 13 10:00:00 2026'))).toBe('running');
    expect(await managerStatus(rec, probe('Sun Sep 13 11:30:00 2026'))).toBe('stopped');
    // Unreadable is not evidence of a different process.
    expect(await managerStatus(rec, probe(undefined))).toBe('running');
  });

  it('falls back to the last-seen window without a pid', async () => {
    const seen = Date.parse('2026-01-01T00:00:00Z');
    const rec = record({ lastSeenAt: new Date(seen).toISOString() });
    const at = (ms: number) => ({ hostname: host, now: () => seen + ms });
    expect(await managerStatus(rec, at(MANAGER_SEEN_WINDOW_MS - 1))).toBe('running');
    expect(await managerStatus(rec, at(MANAGER_SEEN_WINDOW_MS + 1))).toBe('stopped');
  });

  it('isPidAlive: ESRCH is gone, EPERM is alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    const spy = vi.spyOn(process, 'kill');
    spy.mockImplementationOnce(() => {
      throw Object.assign(new Error('eperm'), { code: 'EPERM' });
    });
    expect(isPidAlive(1)).toBe(true);
    spy.mockImplementationOnce(() => {
      throw Object.assign(new Error('esrch'), { code: 'ESRCH' });
    });
    expect(isPidAlive(999_999)).toBe(false);
    spy.mockRestore();
  });
});

describe('upsertDetectedManager', () => {
  const S1 = '5edc0ee0-ce9a-4e30-962d-bc630388d8bc';

  it('creates an external manager, then refreshes it instead of duplicating', async () => {
    const { id, root } = await makeWorkspace();
    const first = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 10,
      host: 'laptop',
    });
    expect(first.created).toBe(true);
    expect(first.manager).toMatchObject({ kind: 'external', pid: 10, workspaceId: id });
    expect(first.manager.id).toMatch(MANAGER_ID_RE);
    const later = new Date(Date.now() + 60_000);
    const again = await upsertDetectedManager(
      id,
      { agent: 'claude', sessionId: S1, cwd: root, pid: 11, host: 'laptop' },
      later,
    );
    expect(again.created).toBe(false);
    expect(again.manager.id).toBe(first.manager.id);
    expect(again.manager.pid).toBe(11);
    expect(again.manager.lastSeenAt).toBe(later.toISOString());
    expect(await readManagers(id)).toHaveLength(1);
  });

  it('joins a hub-run manager to the session id its agent reports', async () => {
    const { id, root } = await makeWorkspace();
    const hub = await startAndRecord({
      wsId: id,
      manager: record({ id: newManagerId(), workspaceId: id, cwd: root, kind: 'tmux' }),
      argv: ['claude'],
      exec: fakeExec().exec,
    });
    const res = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      host: 'laptop',
      pid: 77,
      managerId: hub.id,
    });
    expect(res.created).toBe(false);
    // Its own session: still hub-run, so liveness stays on tmux and no pid is kept.
    expect(res.manager).toMatchObject({ id: hub.id, kind: 'tmux', sessionId: S1 });
    expect(res.manager.pid).toBeUndefined();
  });

  it('flips a hub manager to external when its session is run from a terminal', async () => {
    const { id, root } = await makeWorkspace();
    const hub = await startAndRecord({
      wsId: id,
      manager: record({
        id: newManagerId(),
        workspaceId: id,
        cwd: root,
        kind: 'tmux',
        sessionId: S1,
      }),
      argv: ['claude', '--resume', S1],
      exec: fakeExec().exec,
    });
    const res = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      host: 'laptop',
      pid: 5,
    });
    expect(res.manager).toMatchObject({ id: hub.id, kind: 'external', pid: 5 });
    expect(res.manager.tmuxSession).toBeUndefined();
  });
});

describe('reconcileManagers', () => {
  it('promotes a job to its box and drops a failed job', () => {
    const rec = record({ boxIds: ['live'], boxJobIds: ['j-done', 'j-failed', 'j-queued'] });
    const { managers, changed } = reconcileManagers([rec], {
      jobs: [
        { id: 'j-done', status: 'done', boxId: 'b-new' },
        { id: 'j-failed', status: 'failed' },
        { id: 'j-queued', status: 'queued' },
      ],
    });
    expect(changed).toBe(true);
    expect(managers[0]).toMatchObject({ boxIds: ['live', 'b-new'], boxJobIds: ['j-queued'] });
  });

  // The same rule the task reconciler follows: a box absent from THIS hub's
  // inventory may live on another machine reporting to the same store, so only
  // an explicit destroy or prune (`detachBoxFromManagers`) drops it.
  it('keeps a box this hub has no record of', () => {
    const rec = record({ boxIds: ['elsewhere'] });
    expect(reconcileManagers([rec], { jobs: [] }).changed).toBe(false);
  });

  it('keeps a box a running create has recorded but not registered', () => {
    const rec = record({ boxIds: ['b1'] });
    const ctx = { jobs: [{ id: 'j', status: 'running', boxId: 'b1' }] };
    expect(reconcileManagers([rec], ctx).changed).toBe(false);
  });

  it('forgets a box on the event that says it is gone', async () => {
    const { id, root } = await makeWorkspace();
    const { manager } = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: 's-detach',
      cwd: root,
      host: 'laptop',
    });
    await attachBoxToManager(id, manager.id, { boxId: 'b1' });
    await attachBoxToManager(id, manager.id, { boxId: 'b2' });
    await detachBoxFromManagers(id, 'b1');
    expect((await readManagers(id))[0]?.boxIds).toEqual(['b2']);
    // Idempotent: a prune after a destroy must not throw.
    await detachBoxFromManagers(id, 'b1');
    expect((await readManagers(id))[0]?.boxIds).toEqual(['b2']);
  });

  it("inherits a box's manager only inside that manager's workspace", async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const { manager } = await upsertDetectedManager(a.id, {
      agent: 'claude',
      sessionId: 's',
      cwd: a.root,
      host: 'laptop',
    });
    await attachBoxToManager(a.id, manager.id, { boxId: 'box-1' });
    expect(await managerIdForTarget({ boxId: 'box-1' })).toBe(manager.id);
    expect(await managerIdForTarget({ boxId: 'box-1' }, { workspaceId: a.id })).toBe(manager.id);
    expect(await managerIdForTarget({ boxId: 'box-1' }, { workspaceId: b.id })).toBeUndefined();
  });

  it('heals on read and remembers which manager made a box', async () => {
    const { id, root } = await makeWorkspace();
    const { manager } = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: 's1',
      cwd: root,
      host: 'laptop',
    });
    await attachBoxToManager(id, manager.id, { boxJobId: 'j1' });
    await attachBoxToManager(id, manager.id, { boxJobId: 'j1' });
    expect(await managerIdForTarget({ boxJobId: 'j1' })).toBe(manager.id);
    const healed = await readReconciledManagers(id, {
      jobs: [{ id: 'j1', status: 'done', boxId: 'b1' }],
    });
    expect(healed[0]).toMatchObject({ boxIds: ['b1'], boxJobIds: [] });
    expect((await readManagers(id))[0]?.boxIds).toEqual(['b1']);
    expect(await managerIdForTarget({ boxId: 'b1' })).toBe(manager.id);
  });
});

describe('resumeManagerSession', () => {
  it('refuses while an external process is alive, then resumes in tmux as a hub manager', async () => {
    const { id, root } = await makeWorkspace();
    const { manager } = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: 'sess-1',
      cwd: root,
      pid: 9,
      host: 'laptop',
    });
    const { calls, exec } = fakeExec();
    const probe = { exec, hostname: () => 'laptop' };
    await expect(
      resumeManagerSession(manager, { ...probe, isPidAlive: () => true }),
    ).rejects.toBeInstanceOf(ManagerConflictError);
    expect(calls).toEqual([]);
    const registration = await resumeManagerSession(manager, { ...probe, isPidAlive: () => false });
    expect(calls[0]!.args[9]).toContain(`'claude' '--resume' 'sess-1'`);
    expect(registration).toMatchObject({
      id: manager.id,
      kind: 'tmux',
      host: 'laptop',
      argv: ['claude', '--resume', 'sess-1'],
    });
    const resumed = await fileManagerStore().registerManager(id, registration);
    expect(resumed).toMatchObject({ id: manager.id, kind: 'tmux' });
    expect(resumed?.pid).toBeUndefined();
  });

  it('refuses a session that ran on another machine, whose transcript is not here', async () => {
    const { id, root } = await makeWorkspace();
    const { manager } = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: 'sess-remote',
      cwd: root,
      pid: 9,
      host: 'laptop',
    });
    const { calls, exec } = fakeExec();
    const err = await resumeManagerSession(manager, {
      exec,
      hostname: () => 'vps',
      isPidAlive: () => false,
      now: () => Date.now() + MANAGER_SEEN_WINDOW_MS * 2,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagerConflictError);
    expect((err as Error).message).toMatch(/runs on laptop; its transcript is not on this machine/);
    expect(calls).toEqual([]);
  });

  it('refuses a manager with no session id rather than starting a fresh agent', async () => {
    const { id, root } = await makeWorkspace();
    const hub = await startAndRecord({
      wsId: id,
      manager: record({ id: newManagerId(), workspaceId: id, cwd: root, kind: 'tmux' }),
      argv: ['claude'],
      exec: fakeExec().exec,
    });
    await expect(
      resumeManagerSession(hub, { exec: fakeExec(['has-session']).exec, hostname: () => 'laptop' }),
    ).rejects.toThrow(/no session id/);
  });
});

describe('stopManagerSession', () => {
  it('kills the session, stamps stoppedAt and keeps the record for a resume', async () => {
    const { id, root } = await makeWorkspace();
    const { calls, exec } = fakeExec();
    const hub = await startAndRecord({
      wsId: id,
      manager: record({ id: newManagerId(), workspaceId: id, cwd: root, kind: 'tmux' }),
      argv: ['claude'],
      exec,
    });
    const patch = await stopManagerSession(hub, { exec, hostname: () => 'laptop' });
    expect(calls.at(-1)?.args).toEqual(['kill-session', '-t', `=agentbox-manager-${hub.id}`]);
    expect(patch?.stoppedAt).toBeTruthy();
    const stopped = await fileManagerStore().patchManager(id, hub.id, patch!);
    expect(stopped?.agent).toBe('claude');
  });

  it('never signals an external process, and is null for an unknown manager', async () => {
    const { id, root } = await makeWorkspace();
    const { manager } = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: 's',
      cwd: root,
      host: 'laptop',
    });
    const { calls, exec } = fakeExec();
    const probe = { exec, hostname: () => 'laptop', isPidAlive: () => true };
    await expect(stopManagerSession(manager, probe)).rejects.toBeInstanceOf(ManagerConflictError);
    expect(calls).toEqual([]);
    // A session that has already ended is nothing to persist.
    expect(
      await stopManagerSession(manager, {
        ...probe,
        isPidAlive: () => false,
        now: () => Date.now() + MANAGER_SEEN_WINDOW_MS * 2,
      }),
    ).toBeNull();
  });

  it('removes a record and its exit file', async () => {
    const { id, root } = await makeWorkspace();
    const { manager } = await upsertDetectedManager(id, {
      agent: 'claude',
      sessionId: 's',
      cwd: root,
      host: 'laptop',
    });
    expect(await removeManagerRecord(id, manager.id)).toBe(true);
    expect(await readManagers(id)).toEqual([]);
    expect(await removeManagerRecord(id, manager.id)).toBe(false);
  });
});

describe('toManagerView', () => {
  it('drops argv, counts its tasks, and only offers attach for a running hub manager', () => {
    const rec = record({ kind: 'tmux', tmuxSession: 't', argv: ['claude'], lastExit: 1 });
    const tasks = [
      { id: 'T-1', managerId: rec.id, status: 'done' },
      { id: 'T-2', managerId: rec.id, status: 'todo' },
      { id: 'T-3', status: 'todo' },
    ] as WorkTask[];
    const running = toManagerView(rec, { status: 'running', workspaceName: 'w', tasks });
    expect(running).not.toHaveProperty('argv');
    expect(running.lastExit).toBeUndefined();
    expect(running.attachCommand).toBe('tmux attach -t =t');
    expect(running.taskCounts).toEqual({ open: 1, done: 1 });
    const stopped = toManagerView(rec, { status: 'stopped', workspaceName: 'w', tasks: [] });
    expect(stopped.attachCommand).toBeUndefined();
    expect(stopped.lastExit).toBe(1);
  });

  it('is resumable when a resume would be accepted, wherever the reader is', () => {
    const ext = record({ sessionId: 's', host: 'laptop', pid: 1 });
    expect(isManagerResumable(ext, 'stopped')).toBe(true);
    expect(isManagerResumable(ext, 'running')).toBe(false);
    expect(isManagerResumable({ ...ext, agent: 'opencode' }, 'stopped')).toBe(false);
    expect(isManagerResumable(record({ kind: 'tmux' }), 'stopped')).toBe(false);
    // WHERE it may be resumed is `host`, which a client compares itself.
    const view = toManagerView(ext, {
      status: 'stopped',
      workspaceName: 'w',
      tasks: [],
      hostname: 'vps',
    });
    expect(view.resumable).toBe(true);
    expect(view.hostIsHub).toBe(false);
    expect(view).not.toHaveProperty('resumeBlockedBy');
    const ok = toManagerView(ext, {
      status: 'stopped',
      workspaceName: 'w',
      tasks: [],
      hostname: 'laptop',
    });
    expect(ok.hostIsHub).toBe(true);
    expect(ok.resumable).toBe(true);
  });

  it('names why a manager cannot be resumed, in the order a resume checks', () => {
    const ext = record({ sessionId: 's', host: 'laptop', pid: 1 });
    expect(managerResumeBlock(ext, 'running')).toBe('running');
    expect(managerResumeBlock(record({ kind: 'tmux' }), 'stopped')).toBe('no-session');
    expect(managerResumeBlock({ ...ext, agent: 'pi' }, 'stopped')).toBe('unsupported-agent');
    expect(managerResumeBlock(ext, 'stopped')).toBeUndefined();
  });
});

describe('listResumableHostSessions', () => {
  async function seedSessions(): Promise<{ home: string; root: string }> {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-home-')));
    const root = '/Users/dev/code/app';
    const dir = join(home, '.claude', 'projects', '-Users-dev-code-app');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'aaa.jsonl'),
      [
        JSON.stringify({ type: 'summary' }),
        JSON.stringify({ type: 'user', message: { content: 'plan the v2 onboarding' } }),
      ].join('\n') + '\n',
    );
    await writeFile(
      join(dir, 'bbb.jsonl'),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'fix   flaky\ndetox tests' }] },
      }) + '\n',
    );
    // A subagent transcript, not a resumable session.
    await writeFile(
      join(dir, 'agent-ccc.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'sub' } }) + '\n',
    );
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    const old = new Date(Date.now() - 86_400_000);
    await utimes(join(dir, 'bbb.jsonl'), old, old);
    return { home, root };
  }

  it('lists claude sessions newest first with a title from the first user turn', async () => {
    const { home, root } = await seedSessions();
    const res = await listResumableHostSessions(root, 'claude', home);
    expect(res.supported).toBe(true);
    expect(res.sessions.map((s) => s.id)).toEqual(['aaa', 'bbb']);
    expect(res.sessions[0]?.title).toBe('plan the v2 onboarding');
    expect(res.sessions[1]?.title).toBe('fix flaky detox tests');
  });

  it('is supported-but-empty for a folder claude never ran in', async () => {
    const { home } = await seedSessions();
    const res = await listResumableHostSessions('/nowhere', 'claude', home);
    expect(res).toEqual({ agent: 'claude', supported: true, sessions: [] });
  });

  it('declares the other agents unsupported rather than guessing', async () => {
    const { home, root } = await seedSessions();
    expect(await listResumableHostSessions(root, 'opencode', home)).toEqual({
      agent: 'opencode',
      supported: false,
      sessions: [],
    });
  });
});

describe('listResumableHostSessions (flat rollout store)', () => {
  const MINE = '11111111-2222-4333-8444-555555555555';
  const OTHER = '99999999-8888-4777-8666-555555555555';
  const NAMED = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const BIG = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const INJECTED = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
  const SYMLINKED = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';

  function rollout(cwd: string, lines: unknown[] = []): string {
    return (
      [
        JSON.stringify({ type: 'session_meta', payload: { cwd } }),
        ...lines.map((l) => JSON.stringify(l)),
      ].join('\n') + '\n'
    );
  }

  /** A rollout store holding one session in `root` and one in another folder. */
  async function seedRollouts(opts: { index?: string } = {}): Promise<{
    home: string;
    root: string;
  }> {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-home-')));
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-ws-')));
    const dir = join(home, '.codex', 'sessions', '2026', '09', '07');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `rollout-2026-09-07T09-34-40-${MINE}.jsonl`),
      rollout(root, [
        { payload: { type: 'message', role: 'developer', content: [{ text: 'system brief' }] } },
        {
          payload: { type: 'message', role: 'user', content: [{ text: '<recommended_plugins>' }] },
        },
        { payload: { type: 'message', role: 'user', content: [{ text: 'split   the\nbacklog' }] } },
      ]),
    );
    await writeFile(
      join(dir, `rollout-2026-09-07T09-38-53-${OTHER}.jsonl`),
      rollout('/somewhere/else', [
        { payload: { type: 'message', role: 'user', content: [{ text: 'not this one' }] } },
      ]),
    );
    await writeFile(
      join(dir, `rollout-2026-09-07T09-40-01-${NAMED}.jsonl`),
      rollout(root, [
        { payload: { type: 'message', role: 'user', content: [{ text: 'scraped title' }] } },
      ]),
    );
    // Neither a rollout nor a session id — both must be skipped, not crash.
    await writeFile(join(dir, 'rollout-2026-09-07T09-41-01-nope.jsonl'), '{}\n');
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    if (opts.index !== undefined) {
      await writeFile(join(home, '.codex', 'session_index.jsonl'), opts.index);
    }
    const old = new Date(Date.now() - 86_400_000);
    await utimes(join(dir, `rollout-2026-09-07T09-40-01-${NAMED}.jsonl`), old, old);
    return { home, root };
  }

  it('keeps only the sessions whose recorded cwd is the workspace root', async () => {
    const { home, root } = await seedRollouts();
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.supported).toBe(true);
    // The id is the TRAILING uuid, not the timestamp prefix; newest first.
    expect(res.sessions.map((s) => s.id)).toEqual([MINE, NAMED]);
    expect(res.sessions.every((s) => s.agent === 'codex')).toBe(true);
  });

  it('scrapes the first real user turn when the store has no name for it', async () => {
    const { home, root } = await seedRollouts();
    const res = await listResumableHostSessions(root, 'codex', home);
    // The `<recommended_plugins>` wrapper is not what the user typed.
    expect(res.sessions[0]?.title).toBe('split the backlog');
    expect(res.sessions[1]?.title).toBe('scraped title');
  });

  it('prefers the name the agent indexed, unless it is a command', async () => {
    const { home, root } = await seedRollouts({
      // A BARE slash command, not the `<command-name>` wrapper: the wrapper is
      // already rejected for starting with `<`, so only this shape reaches the
      // slash guard and proves it is doing anything.
      index:
        [
          JSON.stringify({ id: MINE, thread_name: 'group the flaky tests' }),
          JSON.stringify({ id: NAMED, thread_name: '/clear' }),
        ].join('\n') + '\n',
    });
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions[0]?.title).toBe('group the flaky tests');
    expect(res.sessions[1]?.title).toBe('scraped title');
  });

  it('reads the newest rows of an index that has outgrown the read budget', async () => {
    // The index is append-only, so the rows a picker needs are at the END. A
    // reader that keeps the first megabyte resolves titles for exactly the
    // sessions nobody is looking for.
    const filler = Array.from({ length: 12_000 }, (_, i) =>
      JSON.stringify({ id: `filler-${i}`, thread_name: 'x'.repeat(80) }),
    );
    const { home, root } = await seedRollouts({
      index:
        [...filler, JSON.stringify({ id: MINE, thread_name: 'the newest name' })].join('\n') + '\n',
    });
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions[0]?.title).toBe('the newest name');
  });

  it('lists a session whose opening record is larger than the head budget', async () => {
    // `session_meta` carries the agent's instructions and every configured tool:
    // measured at 49 KB on a plain setup and growing with each MCP server. A
    // fixed-size head read silently drops the whole session, because that line
    // is the only place the folder is recorded.
    const { home, root } = await seedRollouts();
    const dir = join(home, '.codex', 'sessions', '2026', '09', '08');
    await mkdir(dir, { recursive: true });
    const huge = JSON.stringify({
      type: 'session_meta',
      payload: { cwd: root, tools: 'z'.repeat(400_000) },
    });
    await writeFile(
      join(dir, `rollout-2026-09-08T10-00-00-${BIG}.jsonl`),
      [
        huge,
        JSON.stringify({
          payload: { type: 'message', role: 'user', content: [{ text: 'after the big record' }] },
        }),
      ].join('\n') + '\n',
    );
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions.map((s) => s.id)).toContain(BIG);
    expect(res.sessions.find((s) => s.id === BIG)?.title).toBe('after the big record');
  });

  it('ranks by last activity, not by the creation time in the filename', async () => {
    // A resumed session keeps appending to its ORIGINAL file, so the filename's
    // timestamp is creation time and says nothing about what is being worked on.
    const { home, root } = await seedRollouts();
    const dir = join(home, '.codex', 'sessions', '2026', '09', '07');
    const touched = new Date(Date.now() + 3_600_000);
    await utimes(join(dir, `rollout-2026-09-07T09-40-01-${NAMED}.jsonl`), touched, touched);
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions.map((s) => s.id)).toEqual([NAMED, MINE]);
  });

  it('does not name a session after context the agent injected as a user turn', async () => {
    // A repo's instructions file and the harness's own preambles arrive as
    // `role: 'user'` records, so a blind scrape names every session in a repo
    // after its AGENTS.md.
    const { home, root } = await seedRollouts();
    const dir = join(home, '.codex', 'sessions', '2026', '09', '09');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `rollout-2026-09-09T10-00-00-${INJECTED}.jsonl`),
      rollout(root, [
        {
          payload: {
            type: 'message',
            role: 'user',
            content: [{ text: '# AGENTS.md instructions for /repo' }],
          },
        },
        {
          payload: {
            type: 'message',
            role: 'user',
            content: [{ text: 'The following is the agent history you are assessing.' }],
          },
        },
        {
          payload: {
            type: 'message',
            role: 'user',
            content: [{ text: 'what the user actually asked' }],
          },
        },
      ]),
    );
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions.find((s) => s.id === INJECTED)?.title).toBe('what the user actually asked');
  });

  it('matches a rollout recorded under a symlinked spelling of the root', async () => {
    // macOS hands out `/var/folders/...` which is a symlink to `/private/var/...`,
    // so the path an agent recorded and the path the workspace stores can differ
    // character for character while naming the same folder.
    const { home, root } = await seedRollouts();
    const link = join(await realpath(await mkdtemp(join(tmpdir(), 'agentbox-link-'))), 'alias');
    await symlink(root, link);
    const dir = join(home, '.codex', 'sessions', '2026', '09', '10');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `rollout-2026-09-10T10-00-00-${SYMLINKED}.jsonl`),
      rollout(link, [
        { payload: { type: 'message', role: 'user', content: [{ text: 'through the symlink' }] } },
      ]),
    );
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions.map((s) => s.id)).toContain(SYMLINKED);
  });

  it("skips the agent's own internal threads", async () => {
    // A store mixes real sessions with the agent's plumbing: threads that review
    // a command, threads a subagent ran. On a real store those were 49 of 71
    // files, none with a user turn to name it, and resuming one drops the user
    // inside the machinery.
    const { home, root } = await seedRollouts();
    const dir = join(home, '.codex', 'sessions', '2026', '09', '11');
    await mkdir(dir, { recursive: true });
    for (const [id, source] of [
      ['eeeeeeee-1111-4222-8333-444444444444', 'guardian_review'],
      ['ffffffff-1111-4222-8333-444444444444', 'subagent'],
    ] as const) {
      await writeFile(
        join(dir, `rollout-2026-09-11T10-00-00-${id}.jsonl`),
        [
          JSON.stringify({ type: 'session_meta', payload: { cwd: root, thread_source: source } }),
          JSON.stringify({
            payload: { type: 'message', role: 'user', content: [{ text: 'internal' }] },
          }),
        ].join('\n') + '\n',
      );
    }
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions.map((s) => s.id)).toEqual([MINE, NAMED]);
  });

  it('is supported-but-empty for a folder the agent never ran in', async () => {
    const { home } = await seedRollouts();
    expect(await listResumableHostSessions('/nowhere', 'codex', home)).toEqual({
      agent: 'codex',
      supported: true,
      sessions: [],
    });
  });
});
