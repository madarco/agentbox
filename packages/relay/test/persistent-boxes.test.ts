import { describe, expect, it } from 'vitest';
import {
  selectPersistentBoxesToStart,
  startPersistentBoxLoop,
  type PersistentBoxEntry,
} from '../src/persistent-boxes.js';
import type { BoxRecord, BoxRuntimeState, Provider } from '@agentbox/core';

function pEntry(p: Partial<PersistentBoxEntry> & { boxId: string }): PersistentBoxEntry {
  return { name: p.boxId, provider: 'docker', state: 'stopped', ...p };
}

describe('selectPersistentBoxesToStart', () => {
  it('starts stopped and paused boxes', () => {
    const out = selectPersistentBoxesToStart([
      pEntry({ boxId: 'a', state: 'stopped' }),
      pEntry({ boxId: 'b', state: 'paused' }),
    ]);
    expect(out.map((e) => e.boxId)).toEqual(['a', 'b']);
  });

  it('leaves a running box alone', () => {
    expect(selectPersistentBoxesToStart([pEntry({ boxId: 'a', state: 'running' })])).toEqual([]);
  });

  it('skips a missing box — its sandbox is gone, starting it is not possible', () => {
    expect(selectPersistentBoxesToStart([pEntry({ boxId: 'a', state: 'missing' })])).toEqual([]);
  });
});

function box(id: string, provider = 'docker'): BoxRecord {
  return {
    id,
    name: id,
    provider,
    container: `agentbox-${id}`,
    image: 'agentbox/box:dev',
    workspacePath: '/workspace',
    persistent: true,
  } as BoxRecord;
}

function fakeProvider(state: BoxRuntimeState, calls: string[]): Provider {
  return {
    name: 'docker',
    probeState: async () => state,
    reconnect: async (b: BoxRecord) => {
      calls.push(b.id);
      return b;
    },
  } as unknown as Provider;
}

describe('startPersistentBoxLoop', () => {
  it('brings a stopped persistent box back on the boot reconcile', async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const loop = startPersistentBoxLoop({
      log: (l) => lines.push(l),
      listPersistentBoxes: async () => [box('svc')],
      resolveProvider: async () => fakeProvider('stopped', calls),
      intervalMs: 60_000,
    });
    await loop.firstTick;
    await loop.stop();
    expect(calls).toEqual(['svc']);
    expect(lines.join('\n')).toContain('svc is running again');
  });

  it('leaves a running box alone', async () => {
    const calls: string[] = [];
    const loop = startPersistentBoxLoop({
      log: () => {},
      listPersistentBoxes: async () => [box('svc')],
      resolveProvider: async () => fakeProvider('running', calls),
      intervalMs: 60_000,
    });
    await loop.firstTick;
    await loop.stop();
    expect(calls).toEqual([]);
  });

  it('reports a missing box once and does not try to start it', async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const loop = startPersistentBoxLoop({
      log: (l) => lines.push(l),
      listPersistentBoxes: async () => [box('svc')],
      resolveProvider: async () => fakeProvider('missing', calls),
      intervalMs: 60_000,
    });
    await loop.firstTick;
    await loop.stop();
    expect(calls).toEqual([]);
    expect(lines.filter((l) => l.includes('is missing'))).toHaveLength(1);
  });

  it('survives a provider that cannot be resolved', async () => {
    const lines: string[] = [];
    const loop = startPersistentBoxLoop({
      log: (l) => lines.push(l),
      listPersistentBoxes: async () => [box('svc', 'nosuch')],
      resolveProvider: async () => null,
      intervalMs: 60_000,
    });
    await loop.firstTick;
    await loop.stop();
    expect(lines.join('\n')).toContain("no provider 'nosuch'");
  });

  it('logs a failed restart and does not throw', async () => {
    const lines: string[] = [];
    const provider = {
      name: 'docker',
      probeState: async () => 'stopped' as const,
      reconnect: async () => {
        throw new Error('docker daemon is down');
      },
    } as unknown as Provider;
    const loop = startPersistentBoxLoop({
      log: (l) => lines.push(l),
      listPersistentBoxes: async () => [box('svc')],
      resolveProvider: async () => provider,
      intervalMs: 60_000,
    });
    await loop.firstTick;
    await loop.stop();
    expect(lines.join('\n')).toContain('docker daemon is down');
  });
});
