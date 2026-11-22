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
});
