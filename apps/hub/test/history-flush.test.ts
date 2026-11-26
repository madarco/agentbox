import { describe, expect, it } from 'vitest';
import type { BoxRecord } from '@agentbox/core';
import { flushBoxHistory } from '../lib/backend/history-flush';

const box = (provider: string): BoxRecord =>
  ({ id: 'b1', name: 'smoke', provider }) as unknown as BoxRecord;

describe('flushBoxHistory', () => {
  it('settles a timed-out docker flush before returning, so no helper outlives it into volume rm', async () => {
    const order: string[] = [];
    await flushBoxHistory(box('docker'), {
      relayHistory: {
        flushBox: () => new Promise(() => order.push('flush started')), // never settles
        settleBox: async () => {
          order.push('settled');
        },
      },
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      probeState: async () => 'running',
      log: (l) => order.push(l.includes('timed out') ? 'timeout' : l),
      timeoutMs: 20,
    });
    order.push('returned');
    expect(order).toEqual(['flush started', 'timeout', 'settled', 'returned']);
  });

  it('runs the docker in-box flush before the relay read (the row cursor writes first)', async () => {
    const order: string[] = [];
    await flushBoxHistory(box('docker'), {
      relayHistory: {
        flushBox: async () => void order.push('relay read'),
        settleBox: async () => undefined,
      },
      exec: async () => {
        order.push('in-box flush');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      probeState: async () => 'running',
      log: () => {},
    });
    expect(order).toEqual(['in-box flush', 'relay read']);
  });

  it('starts the relay read once the in-box head start is spent, even if the in-box flush hangs', async () => {
    let read = false;
    await flushBoxHistory(box('docker'), {
      relayHistory: {
        flushBox: async () => void (read = true),
        settleBox: async () => undefined,
      },
      exec: () => new Promise(() => {}), // never answers
      probeState: async () => 'running',
      log: () => {},
      inBoxFirstMs: 10,
      timeoutMs: 200,
    });
    expect(read).toBe(true);
  });

  it('settles after a successful docker flush too', async () => {
    let settled = false;
    await flushBoxHistory(box('docker'), {
      relayHistory: { flushBox: async () => null, settleBox: async () => void (settled = true) },
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      probeState: async () => 'running',
      log: () => {},
    });
    expect(settled).toBe(true);
  });

  it('runs the in-box flush only for a running cloud box, and never settles docker state for it', async () => {
    const execs: string[][] = [];
    let settled = false;
    const deps = (state: string) => ({
      relayHistory: { flushBox: async () => null, settleBox: async () => void (settled = true) },
      exec: async (_b: BoxRecord, argv: string[]) => {
        execs.push(argv);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      probeState: async () => state,
      log: () => {},
    });
    await flushBoxHistory(box('e2b'), deps('paused'));
    expect(execs).toEqual([]);
    await flushBoxHistory(box('e2b'), deps('running'));
    expect(execs).toEqual([['agentbox-ctl', 'history', 'flush']]);
    expect(settled).toBe(false);
  });

  it('also runs the in-box flush (memory) for a running docker box, not for a paused one', async () => {
    const execs: string[][] = [];
    const deps = (state: string) => ({
      relayHistory: { flushBox: async () => null, settleBox: async () => undefined },
      exec: async (_b: BoxRecord, argv: string[]) => {
        execs.push(argv);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      probeState: async () => state,
      log: () => {},
    });
    await flushBoxHistory(box('docker'), deps('paused'));
    expect(execs).toEqual([]);
    await flushBoxHistory(box('docker'), deps('running'));
    expect(execs).toEqual([['agentbox-ctl', 'history', 'flush']]);
  });

  it('a stop or pause flush never settles the docker reads, and refreshes the usage after', async () => {
    for (const reason of ['stop', 'pause'] as const) {
      let settled = false;
      let after = 0;
      const order: string[] = [];
      await flushBoxHistory(box('docker'), {
        relayHistory: {
          flushBox: async () => void order.push('relay read'),
          settleBox: async () => void (settled = true),
        },
        exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        probeState: async () => 'running',
        log: () => {},
        reason,
        afterFlush: async () => void after++,
      });
      expect(order).toEqual(['relay read']);
      expect(settled).toBe(false);
      expect(after).toBe(1);
    }
  });

  it('a stop on a dead cloud box returns at its bound, saying it stops anyway', async () => {
    const lines: string[] = [];
    let after = 0;
    await flushBoxHistory(box('hetzner'), {
      relayHistory: { flushBox: async () => null, settleBox: async () => undefined },
      exec: () => new Promise(() => {}), // the box never answers
      probeState: async () => 'running',
      log: (l) => lines.push(l),
      reason: 'stop',
      timeoutMs: 20,
      afterFlush: async () => void after++,
    });
    expect(lines.some((l) => l.includes('timed out; stopping anyway'))).toBe(true);
    expect(after).toBe(1);
  });

  it('a stop or pause of a box that is not running ships nothing (the destroy will)', async () => {
    for (const provider of ['docker', 'e2b']) {
      let read = false;
      let execd = false;
      await flushBoxHistory(box(provider), {
        relayHistory: {
          flushBox: async () => void (read = true),
          settleBox: async () => undefined,
        },
        exec: async () => {
          execd = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        probeState: async () => 'stopped',
        log: () => {},
        reason: 'pause',
      });
      expect({ read, execd }).toEqual({ read: false, execd: false });
    }
  });
});
