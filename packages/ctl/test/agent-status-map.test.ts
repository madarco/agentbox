import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import { normalizeAgentStatus, LEGACY_AGENT_STATUS_KEYS } from '@agentbox/core';
import { BAKED_AGENT_SESSIONS, StatusReporter } from '../src/status-reporter.js';
import type { BoxStatus } from '../src/types.js';

// `vi.mock` is hoisted above every const in the module, so the fake tmux state
// has to be hoisted with it.
const { RUNNING, TITLES } = vi.hoisted(() => ({
  RUNNING: new Set<string>(),
  TITLES: new Map<string, string>(),
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

interface Posted {
  type: string;
  payload: unknown;
}

function makeReporter(sessions?: { agent: string; sessionName: string }[]): {
  reporter: StatusReporter;
  posted: Posted[];
} {
  const posted: Posted[] = [];
  const sup = Object.assign(new EventEmitter(), {
    list: () => [],
    listTasks: () => [],
    serviceProbePorts: () => new Map<string, number>(),
    probedServices: () => new Set<string>(),
    serviceExposes: () => new Map<string, { port: number; as: number }>(),
  });
  type Opts = ConstructorParameters<typeof StatusReporter>[0];
  const reporter = new StatusReporter({
    supervisor: sup as unknown as Opts['supervisor'],
    relay: {
      enabled: true,
      post: (type: string, payload: unknown) => {
        posted.push({ type, payload });
        return Promise.resolve({ ok: true, status: 202 });
      },
    } as unknown as Opts['relay'],
    boxId: 'b1',
    ...(sessions ? { sessions } : {}),
    debounceMs: 0,
    periodicMs: 60_000,
  });
  return { reporter, posted };
}

async function latest(reporter: StatusReporter, posted: Posted[]): Promise<BoxStatus> {
  posted.length = 0;
  reporter.flush();
  // The push awaits one session probe per agent before it posts.
  for (let i = 0; i < 200 && posted.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const snap = posted[posted.length - 1]?.payload as BoxStatus | undefined;
  if (!snap) throw new Error('reporter never posted a snapshot');
  return snap;
}

describe('BAKED_AGENT_SESSIONS drift vs the agent registry', () => {
  it('probes every agent the registry ships, under its declared session name', () => {
    // ctl deliberately does NOT import the registry (it is baked into the box
    // image and the host owns the list), so the baked default can only be kept
    // honest from the outside — here.
    // Baked agents only: ctl ships inside the image, so an agent added after the
    // bake cannot be in a compiled-in list — it arrives over `agents.list`
    // (#340), which `agent-registry-fetch.test.ts` covers. A hidden agent is
    // exactly that case.
    const baked_specs = AGENT_SYNC_SPECS.filter((s) => !s.hidden);
    for (const spec of baked_specs) {
      const baked = BAKED_AGENT_SESSIONS.find((s) => s.agent === spec.id);
      expect(baked, `missing baked session probe for '${spec.id}'`).toBeDefined();
      expect(baked!.sessionName).toBe(spec.sessionName);
    }
    expect(BAKED_AGENT_SESSIONS).toHaveLength(baked_specs.length);
  });
});

describe('snapshot agent map', () => {
  it('writes the legacy named blocks as a DERIVED mirror of the map', async () => {
    // The mirror is what keeps a host or hub older than this build reading
    // activity at all. If it ever stops tracking the map, that back-compat is
    // silently gone, so assert the two agree rather than that the fields exist.
    RUNNING.clear();
    const { reporter, posted } = makeReporter();
    reporter.setAgentState('claude', 'working');
    reporter.setAgentState('codex', 'idle');
    const snap = await latest(reporter, posted);

    expect(snap.agents?.claude?.state).toBe('working');
    expect(snap.claude?.state).toBe('working');
    expect(snap.codex?.state).toBe('idle');
    for (const key of LEGACY_AGENT_STATUS_KEYS) {
      expect(snap[key as 'claude']).toEqual(snap.agents?.[key]);
    }
    // And the map is recoverable from either half.
    expect(normalizeAgentStatus(snap)).toEqual(snap.agents);
  });

  it('omits an agent with nothing to report', async () => {
    RUNNING.clear();
    const { reporter, posted } = makeReporter();
    reporter.setAgentState('claude', 'idle');
    const snap = await latest(reporter, posted);
    expect(Object.keys(snap.agents ?? {})).toEqual(['claude']);
    expect(snap.codex).toBeUndefined();
  });

  it('reports an agent whose tmux session is up even before it reports a state', async () => {
    RUNNING.clear();
    RUNNING.add('codex');
    TITLES.set('codex', 'fixing the parser');
    const { reporter, posted } = makeReporter();
    const snap = await latest(reporter, posted);
    expect(snap.agents?.codex).toEqual({
      state: 'unknown',
      updatedAt: null,
      sessionRunning: true,
      sessionTitle: 'fixing the parser',
    });
    TITLES.clear();
  });

  it('carries an agent this binary was never baked with', async () => {
    // The payoff: a host-supplied session list makes a post-bake agent report
    // activity with no change to ctl and no re-bake.
    RUNNING.clear();
    RUNNING.add('openclaw');
    const { reporter, posted } = makeReporter([{ agent: 'openclaw', sessionName: 'openclaw' }]);
    reporter.setAgentState('openclaw', 'working');
    const snap = await latest(reporter, posted);
    expect(snap.agents?.openclaw?.state).toBe('working');
    // ...and it is deliberately absent from the legacy mirror: no old reader has
    // a field for it, so inventing one would not help.
    expect(Object.keys(snap).filter((k) => k === 'openclaw')).toEqual([]);
  });

  it('upgrades the probed list at runtime without losing recorded state', async () => {
    RUNNING.clear();
    const { reporter, posted } = makeReporter();
    reporter.setAgentState('codex', 'working');
    reporter.setSessions([{ agent: 'codex', sessionName: 'codex-custom' }]);
    const snap = await latest(reporter, posted);
    expect(snap.agents?.codex?.state).toBe('working');
    expect(reporter.watchedSessions()).toEqual([{ agent: 'codex', sessionName: 'codex-custom' }]);
  });

  it('refuses an empty session list rather than going blind', async () => {
    const { reporter } = makeReporter();
    reporter.setSessions([]);
    expect(reporter.watchedSessions()).toEqual(BAKED_AGENT_SESSIONS);
  });

  it('keeps the sticky end-plan payload per agent, independently', async () => {
    RUNNING.clear();
    const { reporter, posted } = makeReporter();
    const plan = { plan: 'do X', capturedAt: '2026-08-30T00:00:00.000Z' };
    reporter.setAgentState('claude', 'end-plan', { plan });
    reporter.setAgentState('codex', 'working');
    // codex going to `working` must not clear claude's sticky state.
    const snap = await latest(reporter, posted);
    expect(snap.agents?.claude?.state).toBe('end-plan');
    expect(snap.agents?.claude?.plan).toEqual(plan);
    expect(snap.agents?.codex?.state).toBe('working');
  });
});
