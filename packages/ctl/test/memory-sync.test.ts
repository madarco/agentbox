import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemorySeedReply } from '@agentbox/core';
import { MemorySync, type MemoryRpc } from '../src/memory-sync.js';

const b64 = (s: string) => Buffer.from(s).toString('base64');

function fakeRpc(reply: MemorySeedReply | 'unreachable') {
  const puts: Array<{ path: string; content?: string; deleted?: boolean }> = [];
  let putResult: Awaited<ReturnType<MemoryRpc['put']>> = { ok: true, version: 1, changed: true };
  let seeds = 0;
  const rpc: MemoryRpc = {
    async seed() {
      seeds++;
      return reply;
    },
    async put(p) {
      puts.push(p);
      return putResult;
    },
  };
  return {
    rpc,
    puts,
    seeds: () => seeds,
    setPut: (r: typeof putResult) => (putResult = r),
  };
}

describe('MemorySync', () => {
  let dir: string;
  let memDir: string;
  let statePath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mem-sync-'));
    memDir = join(dir, 'memory', 'claude');
    statePath = join(dir, 'state', 'memory-state.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const reply = (
    files: MemorySeedReply['agents'][0]['files'],
    writeBack = true,
  ): MemorySeedReply => ({
    agents: [{ agent: 'claude', boxDir: memDir, scope: 'project', files }],
    writeBack,
  });

  it('seeds once: the hub set replaces the dir and is the baseline', async () => {
    await mkdir(memDir, { recursive: true });
    await writeFile(join(memDir, 'stale.md'), 'from a checkpoint');
    const f = fakeRpc(
      reply([
        { path: 'MEMORY.md', content: b64('index'), sha256: 'x' },
        { path: 'sub/fact.md', content: b64('fact'), sha256: 'y' },
      ]),
    );
    const s = new MemorySync({ rpc: f.rpc, statePath, boxId: 'box-1' });
    expect((await s.pass()).seeded).toEqual(['claude:2']);
    expect((await readdir(memDir)).sort()).toEqual(['MEMORY.md', 'sub']);
    expect(await readFile(join(memDir, 'sub', 'fact.md'), 'utf8')).toBe('fact');
    // Nothing changed since the seed: nothing ships, and no second seed.
    expect((await s.pass()).shipped).toBe(0);
    expect(f.puts).toEqual([]);
    expect(f.seeds()).toBe(1);
    // A restarted daemon reads the baseline back instead of seeding again.
    const again = new MemorySync({ rpc: f.rpc, statePath, boxId: 'box-1' });
    await again.pass();
    expect(f.seeds()).toBe(1);
  });

  it('ships a changed file, a new file and a deletion, then stays quiet', async () => {
    const f = fakeRpc(
      reply([
        { path: 'MEMORY.md', content: b64('index'), sha256: 'x' },
        { path: 'old.md', content: b64('old'), sha256: 'y' },
      ]),
    );
    const s = new MemorySync({ rpc: f.rpc, statePath, boxId: 'box-1' });
    await s.pass();
    await writeFile(join(memDir, 'MEMORY.md'), 'index v2');
    await writeFile(join(memDir, 'new.md'), 'new');
    await rm(join(memDir, 'old.md'));
    expect((await s.pass()).shipped).toBe(3);
    expect(
      f.puts.map((p) => [
        p.path,
        p.deleted ? 'deleted' : Buffer.from(p.content!, 'base64').toString(),
      ]),
    ).toEqual([
      ['MEMORY.md', 'index v2'],
      ['new.md', 'new'],
      ['old.md', 'deleted'],
    ]);
    expect((await s.pass()).shipped).toBe(0);
  });

  it('a state from another box (a checkpoint) is not ours: seed again', async () => {
    const f = fakeRpc(reply([]));
    await new MemorySync({ rpc: f.rpc, statePath, boxId: 'box-a' }).pass();
    await new MemorySync({ rpc: f.rpc, statePath, boxId: 'box-b' }).pass();
    expect(f.seeds()).toBe(2);
  });

  it('files null leaves the dir alone and takes it as the baseline', async () => {
    await mkdir(memDir, { recursive: true });
    await writeFile(join(memDir, 'keep.md'), 'keep');
    const f = fakeRpc(reply(null));
    const s = new MemorySync({ rpc: f.rpc, statePath, boxId: 'box-1' });
    await s.pass();
    expect(await readFile(join(memDir, 'keep.md'), 'utf8')).toBe('keep');
  });

  it('unreachable relay: no seed recorded, retried', async () => {
    const f = fakeRpc('unreachable');
    const s = new MemorySync({ rpc: f.rpc, statePath, boxId: 'box-1' });
    expect((await s.pass()).errors[0]).toMatch(/unreachable/);
    expect(s.seeded).toBe(false);
  });

  it('a disabled answer stops shipping for a while; an unavailable one keeps the change for later', async () => {
    let t = 0;
    const f = fakeRpc(reply([]));
    const s = new MemorySync({ rpc: f.rpc, statePath, boxId: 'box-1', now: () => t });
    await s.pass();
    await writeFile(join(memDir, 'a.md'), 'a');
    f.setPut({ ok: false, code: 'unavailable', message: 'down' });
    await s.pass();
    f.setPut({ ok: true, version: 1, changed: true });
    expect((await s.pass()).shipped).toBe(1);
    await writeFile(join(memDir, 'a.md'), 'a2');
    f.setPut({ ok: false, code: 'disabled', message: 'off' });
    await s.pass();
    const before = f.puts.length;
    await s.pass();
    expect(f.puts.length).toBe(before);
    t += 11 * 60_000;
    await s.pass();
    expect(f.puts.length).toBe(before + 1);
  });

  it('noSeed (a destroy flush) never seeds', async () => {
    const f = fakeRpc(reply([]));
    await new MemorySync({ rpc: f.rpc, statePath, boxId: 'box-1' }).pass({ noSeed: true });
    expect(f.seeds()).toBe(0);
  });

  it('a file over the size cap is not shipped, and never shipped as deleted', async () => {
    const f = fakeRpc(reply([{ path: 'MEMORY.md', content: b64('index'), sha256: 'x' }]));
    const s = new MemorySync({ rpc: f.rpc, statePath, boxId: 'box-1' });
    await s.pass();
    await writeFile(join(memDir, 'MEMORY.md'), 'x'.repeat(300 * 1024));
    expect((await s.pass()).shipped).toBe(0);
    expect(f.puts).toEqual([]);
  });

  it('an older relay (unsupported) backs off instead of retrying every pass', async () => {
    let t = 0;
    const f = fakeRpc('unreachable');
    (f.rpc as { seed: () => Promise<unknown> }).seed = async () => 'unsupported';
    const s = new MemorySync({ rpc: f.rpc, statePath, boxId: 'box-1', now: () => t });
    expect((await s.pass()).errors[0]).toMatch(/unsupported/);
    expect(s.backingOff).toBe(true);
    expect((await s.pass()).errors).toEqual([]);
    t += 11 * 60_000;
    expect((await s.pass()).errors[0]).toMatch(/unsupported/);
  });
});
