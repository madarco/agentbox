import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_SYNC_SPECS, buildAgentDescriptors } from '@agentbox/sandbox-core';
import { parseAgentStatusEntry } from '@agentbox/core';
import { cleanPaneTitle, parsePaneTitleRules } from '../src/pane-title.js';
import { parseAgentDescriptors } from '../src/agent-registry.js';
import { pickOpencodeSession, readOpencodeCandidates } from '../src/opencode-session.js';
import { loadSqlite } from '../src/history-shipper.js';
import type { BoxStatus } from '../src/types.js';

const { RUNNING, TITLES, POINTER, CALLS } = vi.hoisted(() => ({
  RUNNING: new Set<string>(),
  TITLES: new Map<string, string>(),
  POINTER: new Map<string, string>(),
  CALLS: [] as unknown[][],
}));

vi.mock('../src/tmux.js', () => ({
  probeAgentSession: (sessionName: string) =>
    Promise.resolve({
      running: RUNNING.has(sessionName),
      sessionName,
      startedAt: null,
      title: TITLES.get(sessionName) ?? null,
    }),
}));

// The real pointer file lives under the test runner's HOME; never touch it.
vi.mock('../src/session-pointer.js', async (orig) => {
  const real = await orig<typeof import('../src/session-pointer.js')>();
  return {
    ...real,
    readAgentSessionId: (agent: string) => POINTER.get(agent) ?? null,
    clearAgentSessionPointer: (agent: string) => {
      CALLS.push(['clear', agent]);
      POINTER.delete(agent);
    },
    clearAgentSessionPointerIf: (agent: string, id: string) => {
      CALLS.push(['clearIf', agent, id]);
      if (POINTER.get(agent) === id) POINTER.delete(agent);
    },
    recordAgentSessionId: (agent: string, id: string) => {
      CALLS.push(['record', agent, id]);
    },
    appendHistoryBinding: (agent: string, id: string) => {
      CALLS.push(['bind', agent, id]);
    },
    markAgentActive: () => {},
  };
});

vi.mock('../src/client.js', () => ({
  agentState: (...args: unknown[]) => {
    CALLS.push(['daemon', ...args.slice(2)]);
    return Promise.resolve('ok');
  },
}));

const { StatusReporter } = await import('../src/status-reporter.js');
const { applyAgentStateReport } = await import('../src/commands/agent-state.js');

type Reporter = InstanceType<typeof StatusReporter>;
type Opts = ConstructorParameters<typeof StatusReporter>[0];

function makeReporter(extra: Partial<Opts> = {}): { reporter: Reporter; posted: unknown[] } {
  const posted: unknown[] = [];
  const sup = Object.assign(new EventEmitter(), {
    list: () => [],
    listTasks: () => [],
    serviceProbePorts: () => new Map<string, number>(),
    probedServices: () => new Set<string>(),
    serviceExposes: () => new Map<string, { port: number; as: number }>(),
    webProxyState: () => ({ port: 80, target: null }),
  });
  const reporter = new StatusReporter({
    supervisor: sup as unknown as Opts['supervisor'],
    relay: {
      enabled: true,
      post: (_type: string, payload: unknown) => {
        posted.push(payload);
        return Promise.resolve({ ok: true, status: 202 });
      },
    } as unknown as Opts['relay'],
    boxId: 'b1',
    debounceMs: 0,
    periodicMs: 60_000,
    ...extra,
  });
  return { reporter, posted };
}

async function latest(reporter: Reporter, posted: unknown[]): Promise<BoxStatus> {
  posted.length = 0;
  reporter.flush();
  for (let i = 0; i < 200 && posted.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const snap = posted[posted.length - 1] as BoxStatus | undefined;
  if (!snap) throw new Error('reporter never posted a snapshot');
  return snap;
}

beforeEach(() => {
  RUNNING.clear();
  TITLES.clear();
  POINTER.clear();
  CALLS.length = 0;
});

/** The rules each registry row ships, as ctl parses them off the wire. */
function shippedRules(agent: string) {
  const parsed = parseAgentDescriptors(JSON.stringify(buildAgentDescriptors()));
  return parsed?.sessions.find((s) => s.agent === agent)?.paneTitle;
}

describe('pane-title rules on the registry rows (Phase 0 samples)', () => {
  const cases: [string, string, string | null][] = [
    ['claude', '✳ Fix the login bug', 'Fix the login bug'],
    ['claude', '✶ Fix the login bug', 'Fix the login bug'],
    ['claude', '✳ Claude Code', null],
    ['codex', '⠋ Fix the login bug | /workspace', 'Fix the login bug'],
    ['codex', '[ ! ] Action Required | Fix the login bug | /workspace', 'Fix the login bug'],
    ['codex', 'workspace | /workspace', null],
    [
      'opencode',
      'OC | Review server.js for bugs and fix th…',
      'Review server.js for bugs and fix th…',
    ],
    ['opencode', 'OpenCode', null],
    ['pi', 'π - refactor-auth - /workspace', 'refactor-auth'],
    ['pi', 'π - workspace', null],
  ];
  it.each(cases)('%s: %j -> %j', (agent, raw, want) => {
    const rules = shippedRules(agent);
    expect(rules).toBeDefined();
    expect(cleanPaneTitle(raw, rules)).toBe(want);
  });

  it('every built-in TUI agent with activity ships rules', () => {
    for (const spec of AGENT_SYNC_SPECS) {
      if (spec.hidden || spec.caps.activitySource.length === 0) continue;
      expect(shippedRules(spec.id), spec.id).toBeDefined();
    }
  });

  it('drops a pattern that does not compile, keeps the rest', () => {
    const rules = parsePaneTitleRules({ strip: ['(', '^x '], placeholders: ['Y'] });
    expect(rules?.strip).toHaveLength(1);
    expect(cleanPaneTitle('x hello', rules)).toBe('hello');
    expect(cleanPaneTitle('y', rules)).toBe(null);
    expect(parsePaneTitleRules('nope')).toBeUndefined();
  });
});

describe('StatusReporter session id', () => {
  it('publishes the reported id, follows a switch, and survives a swallowed state', async () => {
    RUNNING.add('claude');
    const { reporter, posted } = makeReporter();
    reporter.setAgentState('claude', 'idle', { sessionId: 'aaaa-1111' });
    expect((await latest(reporter, posted)).agents?.claude?.sessionId).toBe('aaaa-1111');

    reporter.setAgentState('claude', 'end-plan');
    reporter.setAgentState('claude', 'working', { sessionId: 'bbbb-2222' }); // swallowed state
    const snap = await latest(reporter, posted);
    expect(snap.agents?.claude?.state).toBe('end-plan');
    expect(snap.agents?.claude?.sessionId).toBe('bbbb-2222');
  });

  it('forgets an ended session only while it is still the current one', async () => {
    RUNNING.add('claude');
    const { reporter, posted } = makeReporter();
    reporter.setAgentState('claude', 'idle', { sessionId: 'new-session-2' });
    // /new: the old session's SessionEnd lands after the new SessionStart.
    reporter.setAgentState('claude', 'idle', { endSessionId: 'old-session-1' });
    expect((await latest(reporter, posted)).agents?.claude?.sessionId).toBe('new-session-2');
    reporter.setAgentState('claude', 'idle', { endSessionId: 'new-session-2' });
    expect((await latest(reporter, posted)).agents?.claude?.sessionId).toBeUndefined();
  });

  it('falls back to the resume pointer after a daemon restart', async () => {
    RUNNING.add('claude');
    POINTER.set('claude', 'from-pointer-1');
    const { reporter, posted } = makeReporter();
    expect((await latest(reporter, posted)).agents?.claude?.sessionId).toBe('from-pointer-1');
  });

  it('cleans the pane title and lets a resolver pick the session', async () => {
    RUNNING.add('opencode');
    TITLES.set('opencode', 'OC | Second session');
    const rules = shippedRules('opencode');
    const { reporter, posted } = makeReporter({
      sessions: [
        { agent: 'opencode', sessionName: 'opencode', ...(rules ? { paneTitle: rules } : {}) },
      ],
      sessionResolvers: {
        opencode: (title, reported) => (title === 'Second session' ? 'ses_two' : reported),
      },
    });
    reporter.setAgentState('opencode', 'idle', { sessionId: 'ses_one' });
    const entry = (await latest(reporter, posted)).agents?.opencode;
    expect(entry?.sessionTitle).toBe('Second session');
    expect(entry?.sessionId).toBe('ses_two');
  });

  it('the entry parser keeps sessionId', () => {
    expect(parseAgentStatusEntry({ state: 'idle', sessionId: 'x1' })?.sessionId).toBe('x1');
    expect(parseAgentStatusEntry({ state: 'idle', sessionId: 3 })?.sessionId).toBeUndefined();
  });

  it('agentStates answers what each agent reported', () => {
    const { reporter } = makeReporter();
    reporter.setAgentState('opencode', 'error');
    expect(reporter.agentStates().opencode?.state).toBe('error');
  });
});

describe('agent-state report', () => {
  const opts = { socket: '/nonexistent.sock' };

  it("drops claude's unnamed-subagent event", async () => {
    await applyAgentStateReport(
      'claude',
      'working',
      { ...opts, skipUnnamedSubagent: true },
      {
        agent_type: '',
      },
    );
    expect(CALLS).toEqual([]);
    await applyAgentStateReport(
      'claude',
      'working',
      { ...opts, skipUnnamedSubagent: true },
      {
        agent_type: 'Explore',
      },
    );
    expect(CALLS).toEqual([['daemon', 'working', undefined]]);
  });

  it('clears the pointer only for the session that ended, and tells the daemon', async () => {
    POINTER.set('claude', 'new-session-2');
    await applyAgentStateReport(
      'claude',
      'idle',
      { ...opts, clearSession: true },
      {
        session_id: 'old-session-1',
      },
    );
    expect(POINTER.get('claude')).toBe('new-session-2');
    expect(CALLS).toContainEqual(['daemon', 'idle', { endSessionId: 'old-session-1' }]);
  });

  it('a payload-less clear (an older hook) still clears unconditionally', async () => {
    POINTER.set('claude', 'x-session-1');
    await applyAgentStateReport('claude', 'idle', { ...opts, clearSession: true }, null);
    expect(POINTER.has('claude')).toBe(false);
  });

  it('capture hands the session id to the daemon', async () => {
    await applyAgentStateReport(
      'codex',
      'working',
      { ...opts, captureSession: true },
      {
        session_id: '019a-codex-session',
      },
    );
    expect(CALLS).toContainEqual(['bind', 'codex', '019a-codex-session']);
    expect(CALLS).toContainEqual(['daemon', 'working', { sessionId: '019a-codex-session' }]);
  });
});

describe('opencode session by pane title', () => {
  const c = (id: string, title: string, updated: number) => ({ id, title, updated });

  it('prefers the session whose title the pane shows (opencode truncates it)', () => {
    const cands = [
      c('ses_a', 'Review server.js for bugs and fix the race', 2),
      c('ses_b', 'Add a health endpoint', 3),
    ];
    expect(pickOpencodeSession('Review server.js for bugs and fix th…', cands, 'ses_b')).toBe(
      'ses_a',
    );
    expect(pickOpencodeSession('Something else', cands, 'ses_b')).toBe('ses_b');
    expect(pickOpencodeSession(null, cands, 'ses_b')).toBe('ses_b');
  });

  it('on a tie keeps the reported session, else the newest', () => {
    const cands = [c('ses_a', 'Same', 1), c('ses_b', 'Same', 5)];
    expect(pickOpencodeSession('Same', cands, 'ses_a')).toBe('ses_a');
    expect(pickOpencodeSession('Same', cands, 'ses_x')).toBe('ses_b');
  });

  it.skipIf(loadSqlite() === null)('reads only this box’s bound root sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-sess-'));
    const dbPath = join(dir, 'opencode.db');
    const mod = loadSqlite()!;
    const db = new mod.DatabaseSync(dbPath);
    db.prepare(
      'CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_updated INTEGER)',
    ).all();
    for (const [id, parent, title, u] of [
      ['ses_mine', null, 'Mine', 10],
      ['ses_child', 'ses_mine', 'Child', 11],
      ['ses_other_box', null, 'Theirs', 12],
    ] as const) {
      db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').all(id, parent, title, u);
    }
    db.close();
    const bindings = join(dir, 'bindings.jsonl');
    writeFileSync(
      bindings,
      [
        { ts: '', boxId: 'b1', agent: 'opencode', sessionId: 'ses_mine' },
        { ts: '', boxId: 'b1', agent: 'opencode', sessionId: 'ses_child' },
        { ts: '', boxId: 'b2', agent: 'opencode', sessionId: 'ses_other_box' },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );
    expect(readOpencodeCandidates({ db: dbPath, bindings, boxId: 'b1' })).toEqual([
      { id: 'ses_mine', title: 'Mine', updated: 10 },
    ]);
  });
});
