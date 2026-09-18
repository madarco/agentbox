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

describe('the +/- lines of a push, measured in the box', () => {
  function execSeams(exec: Provider['exec']) {
    return createBoxFactSeams({
      listBoxes: async () => [box as never],
      readBoxRecord: async (id) => (id === 'box1' ? box : undefined),
      providerForBox: async () => ({ exec }) as unknown as Provider,
      hostname: () => 'laptop',
    });
  }

  it('runs git in the box workspace and answers the shortstat', async () => {
    const argvs: string[][] = [];
    const cwds: (string | undefined)[] = [];
    const s = execSeams(async (_b, argv, opts) => {
      argvs.push(argv);
      cwds.push(opts?.cwd);
      const joined = argv.join(' ');
      if (joined === 'git rev-parse --verify --quiet HEAD^{commit}') {
        return { exitCode: 0, stdout: 'f'.repeat(40), stderr: '' };
      }
      if (joined === `git merge-base origin/HEAD ${'f'.repeat(40)}`) {
        return { exitCode: 0, stdout: 'a'.repeat(40), stderr: '' };
      }
      if (joined === `git diff --shortstat ${'a'.repeat(40)}..${'f'.repeat(40)}`) {
        return {
          exitCode: 0,
          stdout: ' 2 files changed, 6 insertions(+), 1 deletion(-)',
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    });
    expect(await s.boxPushStat('box1')).toEqual({ additions: 6, deletions: 1 });
    expect(argvs.every((a) => a[0] === 'git')).toBe(true);
    expect(new Set(cwds)).toEqual(new Set(['/workspace']));
  });

  it('answers nothing for a box this hub has no record of', async () => {
    const s = execSeams(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    expect(await s.boxPushStat('gone')).toBeUndefined();
  });
});
