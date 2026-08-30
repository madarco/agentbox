import { describe, expect, it } from 'vitest';
import {
  AGENT_ACTIVITY_STATES,
  LEGACY_AGENT_STATUS_KEYS,
  isAgentActivityState,
  legacyAgentStatusFields,
  normalizeAgentStatus,
  parseAgentStatusEntry,
  pickPrimaryAgent,
  type AgentStatusEntry,
  type AgentStatusMap,
} from '../src/sync/agent-status.js';

const entry = (over: Partial<AgentStatusEntry> = {}): AgentStatusEntry => ({
  state: 'idle',
  updatedAt: '2026-08-30T10:00:00.000Z',
  sessionRunning: true,
  ...over,
});

/**
 * The OLD wire shape, verbatim: this is what a box baked before the map keeps
 * posting for as long as it lives. Nothing here may be "fixed up" to look
 * modern — the point of the fixture is that it is what really arrives.
 */
const LEGACY_PAYLOAD = {
  schema: 1,
  boxId: 'abc123',
  timestamp: '2026-08-30T10:00:00.000Z',
  services: [],
  tasks: [],
  ports: [],
  claude: {
    state: 'working',
    updatedAt: '2026-08-30T09:59:00.000Z',
    sessionRunning: true,
    sessionTitle: 'refactor the parser',
  },
  codex: { state: 'idle', updatedAt: '2026-08-30T09:58:00.000Z', sessionRunning: false },
  opencode: { state: 'waiting', updatedAt: '2026-08-30T09:57:00.000Z', sessionRunning: true },
};

describe('activity state union', () => {
  it('has exactly the eight documented states', () => {
    expect([...AGENT_ACTIVITY_STATES].sort()).toEqual(
      [
        'compacting',
        'end-plan',
        'error',
        'idle',
        'question',
        'waiting',
        'working',
        'unknown',
      ].sort(),
    );
  });

  it('guards against anything else', () => {
    expect(isAgentActivityState('working')).toBe(true);
    expect(isAgentActivityState('busy')).toBe(false);
    expect(isAgentActivityState(undefined)).toBe(false);
    expect(isAgentActivityState(3)).toBe(false);
  });
});

describe('parseAgentStatusEntry', () => {
  it('requires a recognizable state and nothing else', () => {
    expect(parseAgentStatusEntry({ state: 'idle' })).toEqual({
      state: 'idle',
      updatedAt: null,
      sessionRunning: false,
    });
  });

  it('rejects a body with no usable state', () => {
    expect(parseAgentStatusEntry({ state: 'nonsense' })).toBeNull();
    expect(parseAgentStatusEntry({})).toBeNull();
    expect(parseAgentStatusEntry(null)).toBeNull();
    expect(parseAgentStatusEntry('idle')).toBeNull();
  });

  it('drops junk field-by-field instead of failing the whole entry', () => {
    const parsed = parseAgentStatusEntry({
      state: 'working',
      updatedAt: 42,
      sessionRunning: 'yes',
      sessionTitle: '',
      plan: 'not an object',
    });
    expect(parsed).toEqual({ state: 'working', updatedAt: null, sessionRunning: false });
  });

  it('carries the plan and question payloads', () => {
    const parsed = parseAgentStatusEntry({
      state: 'end-plan',
      updatedAt: null,
      sessionRunning: true,
      plan: { plan: '# do the thing', capturedAt: 'T' },
    });
    expect(parsed?.plan).toEqual({ plan: '# do the thing', capturedAt: 'T' });
  });

  it('ignores fields a newer producer added', () => {
    const parsed = parseAgentStatusEntry({ state: 'idle', tokensUsed: 999 });
    expect(parsed).toEqual({ state: 'idle', updatedAt: null, sessionRunning: false });
  });
});

describe('normalizeAgentStatus — read-time back-compat', () => {
  it('folds a legacy payload into the map', () => {
    const map = normalizeAgentStatus(LEGACY_PAYLOAD);
    expect(Object.keys(map).sort()).toEqual(['claude', 'codex', 'opencode']);
    expect(map.claude?.state).toBe('working');
    expect(map.claude?.sessionTitle).toBe('refactor the parser');
    expect(map.opencode?.state).toBe('waiting');
  });

  it('passes a current payload through unchanged', () => {
    const map = normalizeAgentStatus({ agents: { claude: entry({ state: 'error' }) } });
    expect(map.claude?.state).toBe('error');
  });

  it('lets `agents` win over the legacy mirror on a dual-shape payload', () => {
    // The current producer writes both; the mirror is the copy, so if they ever
    // disagree the map is the truth.
    const map = normalizeAgentStatus({
      claude: entry({ state: 'idle' }),
      agents: { claude: entry({ state: 'working' }) },
    });
    expect(map.claude?.state).toBe('working');
  });

  it('KEEPS an agent this host has never heard of', () => {
    // A newer box reporting a fourth agent must not read as "idle box" — that is
    // the whole reason the map is keyed rather than named.
    const map = normalizeAgentStatus({ agents: { openclaw: entry({ state: 'working' }) } });
    expect(map.openclaw?.state).toBe('working');
  });

  it('never throws on garbage', () => {
    expect(normalizeAgentStatus(null)).toEqual({});
    expect(normalizeAgentStatus('nope')).toEqual({});
    expect(normalizeAgentStatus({})).toEqual({});
    expect(normalizeAgentStatus({ agents: 7 })).toEqual({});
    expect(normalizeAgentStatus({ agents: { '': entry() } })).toEqual({});
    expect(normalizeAgentStatus({ claude: { state: 'bogus' } })).toEqual({});
  });
});

describe('legacyAgentStatusFields', () => {
  it('mirrors only the frozen legacy names', () => {
    const map: AgentStatusMap = {
      claude: entry(),
      opencode: entry({ state: 'working' }),
      openclaw: entry({ state: 'error' }),
    };
    const mirror = legacyAgentStatusFields(map);
    expect(Object.keys(mirror).sort()).toEqual(['claude', 'opencode']);
    expect(mirror.openclaw).toBeUndefined();
  });

  it('round-trips through the normalizer', () => {
    const map: AgentStatusMap = { claude: entry({ state: 'question' }), codex: entry() };
    expect(normalizeAgentStatus(legacyAgentStatusFields(map))).toEqual(map);
  });

  it('mirrors every legacy key the map holds', () => {
    const map: AgentStatusMap = Object.fromEntries(
      LEGACY_AGENT_STATUS_KEYS.map((k) => [k, entry()]),
    );
    expect(Object.keys(legacyAgentStatusFields(map)).sort()).toEqual(
      [...LEGACY_AGENT_STATUS_KEYS].sort(),
    );
  });
});

describe('pickPrimaryAgent', () => {
  it('prefers a quota-consuming agent over a more recent idle one', () => {
    const picked = pickPrimaryAgent({
      claude: entry({ state: 'working', updatedAt: '2026-08-30T09:00:00.000Z' }),
      codex: entry({ state: 'idle', updatedAt: '2026-08-30T11:00:00.000Z' }),
    });
    expect(picked?.agent).toBe('claude');
  });

  it('counts compacting as busy', () => {
    const picked = pickPrimaryAgent({
      claude: entry({ state: 'idle', updatedAt: '2026-08-30T11:00:00.000Z' }),
      codex: entry({ state: 'compacting', updatedAt: '2026-08-30T09:00:00.000Z' }),
    });
    expect(picked?.agent).toBe('codex');
  });

  it('falls back to the most recently updated', () => {
    const picked = pickPrimaryAgent({
      claude: entry({ state: 'idle', updatedAt: '2026-08-30T09:00:00.000Z' }),
      codex: entry({ state: 'waiting', updatedAt: '2026-08-30T11:00:00.000Z' }),
    });
    expect(picked?.agent).toBe('codex');
  });

  it('answers null for a box with nothing to report', () => {
    expect(pickPrimaryAgent({})).toBeNull();
  });
});
