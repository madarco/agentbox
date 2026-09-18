import { describe, expect, it } from 'vitest';
import type { BoxRecord, Provider } from '@agentbox/core';
import { createBoxFactSeams } from '../lib/backend/box-facts';

const box = { id: 'box1', name: 'box-one', projectRoot: '/repo' } as BoxRecord;

function seams(originUrlOf: (b: BoxRecord) => Promise<string | undefined>) {
  return createBoxFactSeams({
    listBoxes: async () => [box as never],
    readBoxRecord: async () => box,
    providerForBox: async () => ({}) as Provider,
    originUrlOf,
    hostname: () => 'laptop',
  });
}

describe('the origin behind a box fact', () => {
  it('resolves once and reuses the answer', async () => {
    let calls = 0;
    const s = seams(async () => {
      calls++;
      return 'git@github.com:acme/app.git';
    });
    expect((await s.boxFact('box1'))?.originUrl).toBe('git@github.com:acme/app.git');
    expect((await s.boxFact('box1'))?.originUrl).toBe('git@github.com:acme/app.git');
    expect(calls).toBe(1);
  });

  // The bug: a miss (no checkout yet, git failed, registration not written) was
  // memoized for the hub's lifetime, so the box never joined its workspace by
  // repo again until someone restarted the hub.
  it('asks again after a miss, and after a rejection', async () => {
    const answers: (string | undefined)[] = [undefined, undefined, 'git@github.com:acme/app.git'];
    let calls = 0;
    const s = seams(async () => {
      const i = calls++;
      if (i === 1) throw new Error('git exploded');
      return answers[i];
    });
    expect((await s.boxFact('box1'))?.originUrl).toBeUndefined();
    expect((await s.boxFact('box1'))?.originUrl).toBeUndefined();
    expect((await s.boxFact('box1'))?.originUrl).toBe('git@github.com:acme/app.git');
    expect(calls).toBe(3);
  });
});
