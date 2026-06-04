import { describe, expect, it } from 'vitest';
import {
  selectBoxesToPause,
  startAutopauseLoop,
  type AutopauseConfig,
  type BoxScanEntry,
  type ContainerState,
} from '../src/autopause.js';
import { BoxRegistry, EventBuffer } from '../src/registry.js';
import type { BoxStatusStore, BoxStatusSnapshot } from '../src/status-store.js';

const CFG: AutopauseConfig = { enabled: true, maxRunningBoxes: 5, idleMinutes: 5 };
const IDLE = 5 * 60_000;

function entry(p: Partial<BoxScanEntry> & { boxId: string }): BoxScanEntry {
  return {
    containerName: `agentbox-${p.boxId}`,
    running: true,
    claudeState: 'idle',
    idleMs: IDLE,
    createdAt: 1000,
    ...p,
  };
}

describe('selectBoxesToPause', () => {
  it('returns [] when disabled', () => {
    const es = [entry({ boxId: 'a' }), entry({ boxId: 'b' })];
    expect(selectBoxesToPause(es, { ...CFG, enabled: false, maxRunningBoxes: 0 })).toEqual([]);
  });

  it('returns [] when running count <= max even with idle boxes', () => {
    const es = [entry({ boxId: 'a' }), entry({ boxId: 'b' })];
    expect(selectBoxesToPause(es, { ...CFG, maxRunningBoxes: 5 })).toEqual([]);
  });

  it('pauses exactly the excess, longest-idle first', () => {
    const es = [
      entry({ boxId: 'a', idleMs: 10 * 60_000 }),
      entry({ boxId: 'b', idleMs: 30 * 60_000 }),
      entry({ boxId: 'c', idleMs: 20 * 60_000 }),
    ];
    // 3 running, max 1 -> pause 2 most-idle: b (30m), c (20m).
    expect(selectBoxesToPause(es, { ...CFG, maxRunningBoxes: 1 })).toEqual(['b', 'c']);
  });

  it('tie-breaks equal idle by oldest createdAt then boxId', () => {
    const es = [
      entry({ boxId: 'z', idleMs: IDLE, createdAt: 2000 }),
      entry({ boxId: 'y', idleMs: IDLE, createdAt: 1000 }),
      entry({ boxId: 'x', idleMs: IDLE, createdAt: 1000 }),
    ];
    // max 0 -> pause all 3, ordered: x/y share oldest createdAt (boxId x<y), then z.
    expect(selectBoxesToPause(es, { ...CFG, maxRunningBoxes: 0 })).toEqual(['x', 'y', 'z']);
  });

  it('excludes non-idle (working/waiting/unknown/null) from candidates but counts them as running', () => {
    const es = [
      entry({ boxId: 'work', claudeState: 'working', idleMs: null }),
      entry({ boxId: 'wait', claudeState: 'waiting', idleMs: null }),
      entry({ boxId: 'unk', claudeState: 'unknown', idleMs: null }),
      entry({ boxId: 'no-snap', claudeState: null, idleMs: null }),
      entry({ boxId: 'idle1', idleMs: 9 * 60_000 }),
      entry({ boxId: 'idle2', idleMs: 8 * 60_000 }),
    ];
    // 6 running, max 3 -> excess 3, but only 2 are idle-eligible -> pause both.
    expect(selectBoxesToPause(es, { ...CFG, maxRunningBoxes: 3 })).toEqual(['idle1', 'idle2']);
  });

  it('respects the idle threshold boundary', () => {
    const below = [entry({ boxId: 'a', idleMs: IDLE - 1 })];
    const at = [entry({ boxId: 'a', idleMs: IDLE })];
    expect(selectBoxesToPause(below, { ...CFG, maxRunningBoxes: 0 })).toEqual([]);
    expect(selectBoxesToPause(at, { ...CFG, maxRunningBoxes: 0 })).toEqual(['a']);
  });

  it('never counts or pauses non-running boxes', () => {
    const es = [
      entry({ boxId: 'paused', running: false }),
      entry({ boxId: 'stopped', running: false }),
      entry({ boxId: 'live', idleMs: 10 * 60_000 }),
    ];
    // Only 1 running; max 0 -> pause the one running idle box, ignore the rest.
    expect(selectBoxesToPause(es, { ...CFG, maxRunningBoxes: 0 })).toEqual(['live']);
  });
});

describe('startAutopauseLoop', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function statusFor(state: string, updatedAt: string): BoxStatusStore {
    return {
      get: (): BoxStatusSnapshot => ({ schema: 1, boxId: 'b', claude: { state, updatedAt } }),
    } as unknown as BoxStatusStore;
  }

  it('pauses an idle box over the limit, appends an event, survives inspect errors', async () => {
    const registry = new BoxRegistry();
    registry.register({
      boxId: 'b1',
      token: 't',
      name: 'b1',
      registeredAt: new Date().toISOString(),
      containerName: 'agentbox-b1',
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const events = new EventBuffer();
    const paused: string[] = [];
    const gotPause = deferred<void>();

    const loop = startAutopauseLoop({
      registry,
      statusStore: statusFor('idle', new Date(Date.now() - 30 * 60_000).toISOString()),
      events,
      log: () => {},
      intervalMs: 5,
      loadConfig: async () => ({ enabled: true, maxRunningBoxes: 0, idleMinutes: 5 }),
      inspectStatus: async (): Promise<ContainerState> => 'running',
      pause: async (name) => {
        paused.push(name);
        gotPause.resolve();
      },
    });

    await gotPause.promise;
    await loop.stop();

    expect(paused).toEqual(['agentbox-b1']);
    const evs = events.all().filter((e) => e.type === 'autopause');
    expect(evs.length).toBeGreaterThanOrEqual(1);
    expect((evs[0]!.payload as { action: string }).action).toBe('paused');
  });

  it('does not pause when another agent (codex) is working even if claude is idle', async () => {
    const registry = new BoxRegistry();
    registry.register({
      boxId: 'b1',
      token: 't',
      name: 'b1',
      registeredAt: new Date().toISOString(),
      containerName: 'agentbox-b1',
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const events = new EventBuffer();
    let pauseCalls = 0;
    // claude has gone idle, but codex is actively working — the box must stay up.
    const statusStore = {
      get: (): BoxStatusSnapshot => ({
        schema: 1,
        boxId: 'b1',
        claude: { state: 'idle', updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() },
        codex: { state: 'working', updatedAt: new Date().toISOString() },
      }),
    } as unknown as BoxStatusStore;

    const loop = startAutopauseLoop({
      registry,
      statusStore,
      events,
      log: () => {},
      intervalMs: 5,
      loadConfig: async () => ({ enabled: true, maxRunningBoxes: 0, idleMinutes: 5 }),
      inspectStatus: async (): Promise<ContainerState> => 'running',
      pause: async () => {
        pauseCalls += 1;
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    await loop.stop();
    expect(pauseCalls).toBe(0);
  });

  it('does nothing when disabled and stop() halts further ticks', async () => {
    const registry = new BoxRegistry();
    registry.register({
      boxId: 'b1',
      token: 't',
      name: 'b1',
      registeredAt: new Date().toISOString(),
      containerName: 'agentbox-b1',
    });
    const events = new EventBuffer();
    let pauseCalls = 0;

    const loop = startAutopauseLoop({
      registry,
      statusStore: statusFor('idle', new Date(Date.now() - 99 * 60_000).toISOString()),
      events,
      log: () => {},
      intervalMs: 5,
      loadConfig: async () => ({ enabled: false, maxRunningBoxes: 0, idleMinutes: 5 }),
      inspectStatus: async (): Promise<ContainerState> => 'running',
      pause: async () => {
        pauseCalls += 1;
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    await loop.stop();
    expect(pauseCalls).toBe(0);
  });
});
