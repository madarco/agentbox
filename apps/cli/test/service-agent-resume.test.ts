import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BoxRecord } from '@agentbox/core';
import type { HubApiServiceView } from '../src/control-plane/hub-api-client.js';

/**
 * The service command's create-or-resume path, and the three ways it went wrong.
 *
 * All three were reported against a bare `agentbox <agent>` — the form a user
 * actually types — and each failed by doing something plausible instead of
 * nothing.
 */

const getServices = vi.fn();
const restartService = vi.fn();
let outcome: 'ok' | 'not-found' | undefined = 'ok';

vi.mock('../src/control-plane/with-hub.js', () => ({
  withOwningHub: async (_box: unknown, op: (client: unknown) => Promise<void>) => {
    await op({ getServices, restartService });
    return outcome;
  },
}));
vi.mock('../src/provider/registry.js', () => ({
  providerForBox: vi.fn(),
  providerForCreate: vi.fn(),
}));

const { waitForService } = await import('../src/agents/command/service-action.js');

const box = { id: 'b1', name: 'smokebox' } as BoxRecord;

function view(over: Partial<HubApiServiceView>): HubApiServiceView {
  return {
    name: 'demosvc',
    state: 'running',
    pid: 42,
    restarts: 0,
    lastExitCode: null,
    blockedOn: [],
    command: 'demosvc gateway',
    ...over,
  };
}

function queue(...views: (HubApiServiceView | undefined)[]): void {
  getServices.mockReset();
  for (const v of views) {
    getServices.mockResolvedValueOnce({ services: v ? [v] : [], tasks: [], ports: [] });
  }
  getServices.mockResolvedValue({ services: [], tasks: [], ports: [] });
}

beforeEach(() => {
  outcome = 'ok';
  restartService.mockReset();
  restartService.mockResolvedValue(undefined);
});

describe('a stopped unit is resumed, not reported dead', () => {
  it('starts it once and keeps waiting', async () => {
    // `<agent> stop` leaves the unit `stopped`. The bare command is documented
    // as create-or-resume, so it must bring the gateway back rather than fail
    // on a state the caller explicitly asked for.
    queue(view({ state: 'stopped' }), view({ state: 'ready' }));
    const got = await waitForService(box, 'demosvc', 30, () => {});
    expect(got.state).toBe('ready');
    expect(restartService).toHaveBeenCalledWith('b1', 'demosvc');
  });

  it('gives up if the start does not take', async () => {
    // Restarting forever would hide a unit that cannot run.
    queue(view({ state: 'stopped' }), view({ state: 'stopped' }));
    await expect(waitForService(box, 'demosvc', 30, () => {})).rejects.toThrow(/is stopped/);
    expect(restartService).toHaveBeenCalledTimes(1);
  });
});

describe('a hub failure aborts instead of polling to the timeout', () => {
  it('stops on not-found', async () => {
    // The box is unknown to its hub: no amount of waiting fixes that, and the
    // sibling commands already stop on it.
    outcome = 'not-found';
    queue(undefined);
    await expect(waitForService(box, 'demosvc', 30, () => {})).rejects.toThrow(
      /not known to its hub/,
    );
  });

  it('stops when the hub is unreachable', async () => {
    outcome = undefined;
    queue(undefined);
    await expect(waitForService(box, 'demosvc', 30, () => {})).rejects.toThrow(
      /could not reach the hub/,
    );
  });
});
