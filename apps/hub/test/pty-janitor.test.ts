import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listPtySessions, writePtyMeta, type PtySessionMeta } from '@agentbox/sandbox-core';
import { sweepPtySessions } from '../lib/pty-janitor';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ab-janitor-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function meta(managerId: string, pid: number): PtySessionMeta {
  return {
    v: 1,
    managerId,
    workspaceId: 'ws',
    agent: 'claude',
    cwd: '/tmp',
    socket: join(dir, 'pty', `${managerId}.sock`),
    pid,
    startedAt: new Date().toISOString(),
    token: 'tok',
    runId: 'r'.repeat(32),
    cols: 80,
    rows: 24,
    pinned: false,
    leaseGraceMs: 60_000,
  };
}

describe('sweepPtySessions', () => {
  it('drops the leftovers of a host whose process is gone', async () => {
    await writePtyMeta(meta('aaaaaaaaaaaaaaaa', 9991), dir);
    const swept = await sweepPtySessions({
      intervalMs: 1000,
      baseDir: dir,
      isPidAlive: () => false,
    });
    expect(swept).toEqual(['aaaaaaaaaaaaaaaa']);
    expect(await listPtySessions(dir)).toEqual([]);
  });

  it('leaves a live host alone', async () => {
    await writePtyMeta(meta('bbbbbbbbbbbbbbbb', process.pid), dir);
    const swept = await sweepPtySessions({
      intervalMs: 1000,
      baseDir: dir,
      isPidAlive: () => true,
    });
    expect(swept).toEqual([]);
    expect(await listPtySessions(dir)).toHaveLength(1);
  });

  it('sweeps only the dead ones', async () => {
    await writePtyMeta(meta('cccccccccccccccc', 9992), dir);
    await writePtyMeta(meta('dddddddddddddddd', process.pid), dir);
    const swept = await sweepPtySessions({
      intervalMs: 1000,
      baseDir: dir,
      isPidAlive: (pid) => pid === process.pid,
    });
    expect(swept).toEqual(['cccccccccccccccc']);
    expect((await listPtySessions(dir)).map((m) => m.managerId)).toEqual(['dddddddddddddddd']);
  });
});
