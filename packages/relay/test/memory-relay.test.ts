import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentHistoryMemory, HistoryMemorySink } from '@agentbox/core';
import { MemoryRelay, type MemoryAgent } from '../src/history/memory-relay.js';
import { runHistoryRpc } from '../src/history/rpc.js';
import type { BoxRegistration } from '../src/types.js';

const mem: AgentHistoryMemory = {
  boxDir: '/home/vscode/.local/share/agentbox/memory/claude',
  hostRoot: 'projects/<projectKey>/memory',
  scope: 'project',
  hostKey: 'dashed-path',
};

function reg(over: Partial<BoxRegistration> = {}): BoxRegistration {
  return {
    boxId: 'box-1',
    name: 'smoke',
    token: 't',
    originUrl: 'git@github.com:Owner/Repo.git',
    ...over,
  } as BoxRegistration;
}

function fakeSink(): HistoryMemorySink & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async memorySeed(input) {
      calls.push({ op: 'seed', ...input });
      return [
        ...input.hostFiles.map((f) => ({ path: f.path, bytes: f.bytes, sha256: 'h' })),
        { path: 'hub.md', bytes: Buffer.from('from hub'), sha256: 'hh' },
      ];
    },
    async memoryPut(input) {
      calls.push({ op: 'put', ...input });
      return { version: 3, changed: true };
    },
  };
}

describe('MemoryRelay', () => {
  let home: string;
  const root = '/Users/x/proj';
  let agents: () => MemoryAgent[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mem-relay-'));
    const dir = join(home, '.claude', 'projects', '-Users-x-proj', 'memory');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'MEMORY.md'), 'index');
    await writeFile(join(dir, 'sub', 'fact.md'), 'fact');
    agents = () => [{ agent: 'claude', hostConfigDir: join(home, '.claude'), mem }];
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const base = (over: Partial<ConstructorParameters<typeof MemoryRelay>[0]> = {}) =>
    new MemoryRelay({
      log: () => {},
      agents,
      captureEnabled: async () => true,
      projectRoot: async () => root,
      ...over,
    });

  it('seeds from the hub under the repo key, handing it the host copy', async () => {
    const sink = fakeSink();
    const reply = await base({ sink }).seed(reg());
    expect(sink.calls[0]).toMatchObject({ op: 'seed', repoKey: 'github.com/owner/repo' });
    expect((sink.calls[0]!.hostFiles as Array<{ path: string }>).map((f) => f.path).sort()).toEqual(
      ['MEMORY.md', 'sub/fact.md'],
    );
    expect(reply.writeBack).toBe(true);
    expect(reply.agents[0]!.boxDir).toBe(mem.boxDir);
    expect(reply.agents[0]!.files!.map((f) => f.path)).toEqual([
      'MEMORY.md',
      'sub/fact.md',
      'hub.md',
    ]);
  });

  it('with no hub: the host copy, no write-back', async () => {
    const r = base();
    const reply = await r.seed(reg());
    expect(reply.writeBack).toBe(false);
    expect(reply.reason).toMatch(/no hub/);
    expect(
      reply.agents[0]!.files!.map((f) => Buffer.from(f.content!, 'base64').toString()),
    ).toEqual(['index', 'fact']);
    expect(await r.put(reg(), { agent: 'claude', path: 'a.md', content: 'eA==' })).toMatchObject({
      ok: false,
      code: 'disabled',
    });
  });

  it('with capture off: the host copy, nothing stored', async () => {
    const sink = fakeSink();
    const reply = await base({ sink, captureEnabled: async () => false }).seed(reg());
    expect(sink.calls).toEqual([]);
    expect(reply.writeBack).toBe(false);
    expect(reply.agents[0]!.files).toHaveLength(2);
  });

  it('nothing known anywhere: files null, so the box keeps what it holds', async () => {
    const reply = await base({ projectRoot: async () => null }).seed(reg({ originUrl: undefined }));
    expect(reply.agents[0]!.files).toBeNull();
  });

  it('put: redacts, stamps the box, refuses bad paths and unknown agents', async () => {
    const sink = fakeSink();
    const r = base({ sink, redact: async () => Buffer.from('REDACTED') });
    const ok = await r.put(reg(), {
      agent: 'claude',
      path: 'a.md',
      content: Buffer.from('secret').toString('base64'),
    });
    expect(ok).toEqual({ ok: true, version: 3, changed: true });
    const call = sink.calls[0]!;
    expect(Buffer.from(call.bytes as Uint8Array).toString()).toBe('REDACTED');
    expect(call.origin).toMatchObject({ boxId: 'box-1', boxName: 'smoke' });
    expect(await r.put(reg(), { agent: 'claude', path: '../x', content: 'eA==' })).toMatchObject({
      code: 'invalid',
    });
    expect(await r.put(reg(), { agent: 'nope', path: 'a.md', content: 'eA==' })).toMatchObject({
      code: 'invalid',
    });
    expect(await r.put(reg(), { agent: 'claude', path: 'a.md', deleted: true })).toMatchObject({
      ok: true,
    });
    expect(sink.calls[1]!.bytes).toBeNull();
  });

  it('is reachable through runHistoryRpc', async () => {
    const r = await runHistoryRpc(
      null,
      base({ sink: fakeSink() }),
      reg(),
      'history.memory.seed',
      {},
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ writeBack: true });
    const none = await runHistoryRpc(null, null, reg(), 'history.memory.put', {});
    expect(JSON.parse(none.stdout)).toMatchObject({ ok: false, code: 'disabled' });
  });
});
