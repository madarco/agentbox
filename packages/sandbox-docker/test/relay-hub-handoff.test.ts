import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ensureRelay` must never replace a HUB with a lean relay.
 *
 * The hub embeds this same relay daemon and adds the UI, so both bind :8787 and
 * both evict the incumbent. `ensureHub` recognises a lean relay and reclaims it;
 * before this fix `ensureRelay` did NOT recognise a hub, so a version skew (the
 * standing state after any upgrade or publish) made the two evict each other
 * forever. Every eviction SIGTERMs the queue loop mid-job, which is how a queued
 * `-i` job never reaches `running`.
 */
const health = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
const calls = vi.hoisted(() => ({ ensureHub: 0, killed: [] as number[] }));

vi.mock('@agentbox/sandbox-core', async (orig) => {
  const actual = await orig<typeof import('@agentbox/sandbox-core')>();
  return {
    ...actual,
    fetchHealthz: vi.fn(async () => health.value),
    pingHealthz: vi.fn(async () => false),
    // The port now comes from the shared resolver rather than a module constant.
    relayPort: () => 8787,
    portIsOccupied: vi.fn(async () => false),
    processAlive: vi.fn(async () => true),
    killPid: vi.fn(async (pid: number) => {
      calls.killed.push(pid);
    }),
    ensureHub: vi.fn(async () => {
      calls.ensureHub++;
      return { url: '', hostUrl: '', port: 8787 };
    }),
  };
});
vi.mock('../src/docker.js', () => ({
  containerExists: vi.fn(async () => false),
  removeContainer: vi.fn(async () => {}),
}));

const { ensureRelay } = await import('../src/relay.js');

beforeEach(() => {
  calls.ensureHub = 0;
  calls.killed = [];
  process.env['AGENTBOX_CLI_VERSION'] = '2.0.0';
});

describe('ensureRelay vs a hub on the port', () => {
  it('hands a version-mismatched HUB to ensureHub instead of evicting it', async () => {
    health.value = { ok: true, ui: true, cliEntry: true, version: '1.0.0', pid: 4242 };
    await ensureRelay();
    expect(calls.ensureHub).toBe(1);
    // The eviction is the bug: killing the hub is what starts the ping-pong.
    expect(calls.killed).toEqual([]);
  });

  it('reuses a version-matched hub without touching anything', async () => {
    health.value = { ok: true, ui: true, cliEntry: true, version: '2.0.0', pid: 4242 };
    await ensureRelay();
    expect(calls.ensureHub).toBe(0);
    expect(calls.killed).toEqual([]);
  });

  it('still reclaims a hub that lost AGENTBOX_CLI_ENTRY', async () => {
    // cliEntry:false means cp/download/checkpoint would hang for its whole life —
    // worth a restart even though it is a hub. Restart, not replace.
    health.value = { ok: true, ui: true, cliEntry: false, version: '2.0.0', pid: 4242 };
    await ensureRelay();
    expect(calls.ensureHub).toBe(1);
    expect(calls.killed).toEqual([]);
  });
});
