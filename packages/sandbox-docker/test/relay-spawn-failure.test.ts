import { mkdtempSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `agentbox relay start` used to print `relay running on http://127.0.0.1:8787`
 * even when the relay died on EADDRINUSE (issue #302). Two defects made that
 * possible and both are covered here:
 *
 *   - the wait loop used `pingHealthz`, a bare 2xx check, so ANY process
 *     answering /healthz on the port passed as "our relay";
 *   - nothing watched the child, so a relay that exited instantly still cost the
 *     full timeout and left a dead pid in `relay.pid`.
 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-relay-spawn-home-'));
process.env['HOME'] = TEST_HOME;

const state = vi.hoisted(() => ({
  /** What fetchHealthz reports: null = nothing valid answers. */
  health: null as Record<string, unknown> | null,
  /** Whether a raw TCP connect to the port succeeds (a foreign occupant). */
  occupied: false,
  /** Exit the spawned child should simulate, or null to hang. */
  childExit: { code: 1, signal: null } as { code: number | null; signal: string | null } | null,
}));

vi.mock('@agentbox/sandbox-core', async (orig) => {
  const actual = await orig<typeof import('@agentbox/sandbox-core')>();
  return {
    ...actual,
    fetchHealthz: vi.fn(async () => state.health),
    pingHealthz: vi.fn(async () => false),
    portIsOccupied: vi.fn(async () => state.occupied),
    relayPort: () => 8787,
    processAlive: vi.fn(async () => false),
    killPid: vi.fn(async () => {}),
    ensureHub: vi.fn(async () => ({ url: '', hostUrl: '', port: 8787 })),
    resolveCliEntry: () => join(TEST_HOME, 'cli-entry.js'),
  };
});

vi.mock('../src/docker.js', () => ({
  containerExists: vi.fn(async () => false),
  removeContainer: vi.fn(async () => {}),
}));

// A child that reports a pid and then "exits", the way a relay losing the bind
// race does. `unref`/`on` are the only surface spawnRelay touches.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 424242,
    unref: () => {},
    on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === 'exit' && state.childExit) {
        setTimeout(() => {
          cb(state.childExit?.code ?? null, state.childExit?.signal ?? null);
        }, 0);
      }
    },
  })),
}));

const { ensureRelay } = await import('../src/relay.js');

const PID_FILE = join(TEST_HOME, '.agentbox', 'relay.pid');
const LOG_FILE = join(TEST_HOME, '.agentbox', 'relay.log');

beforeEach(() => {
  state.health = null;
  state.occupied = false;
  state.childExit = { code: 1, signal: null };
  writeFileSync(join(TEST_HOME, 'cli-entry.js'), '', 'utf8');
});

describe('relay startup failure is reported, not swallowed', () => {
  it('throws when the spawned relay exits during startup', async () => {
    await expect(ensureRelay()).rejects.toThrow(/relay process exited/);
  });

  it('inlines the tail of relay.log, where the EADDRINUSE line already is', async () => {
    writeFileSync(LOG_FILE, 'agentbox-relay: listen EADDRINUSE 0.0.0.0:8787\n', 'utf8');
    const err = await ensureRelay().catch((e: Error) => e);
    expect(String(err)).toMatch(/last lines of/);
    expect(String(err)).toMatch(/EADDRINUSE/);
  });

  it('points at the log by path when it has nothing to tail', async () => {
    writeFileSync(LOG_FILE, '', 'utf8');
    await expect(ensureRelay()).rejects.toThrow(/see .*relay\.log/);
  });

  it('names the foreign occupant and the way out when the port answers TCP but not /healthz', async () => {
    state.occupied = true;
    const err = await ensureRelay().catch((e: Error) => e);
    expect(String(err)).toMatch(/not an agentbox relay/);
    expect(String(err)).toMatch(/relay\.port/);
  });

  it('does not blame a port conflict when nothing holds the port', async () => {
    state.occupied = false;
    const err = await ensureRelay().catch((e: Error) => e);
    expect(String(err)).not.toMatch(/not an agentbox relay/);
  });

  it('clears the stale pidfile so `relay status` cannot report a dead pid', async () => {
    await ensureRelay().catch(() => {});
    expect(existsSync(PID_FILE)).toBe(false);
  });
});
