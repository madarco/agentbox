import { describe, expect, it } from 'vitest';
import type { HistoryFrame, HistoryIngestResult } from '@agentbox/core';
import { parseHistoryFrame as parseFrame } from '@agentbox/core';
import { HistoryRelay } from '../src/history/history-relay.js';
import { removeHistoryHelpers, untarSingleFile } from '../src/history/docker-source.js';
import { runHistoryRpc } from '../src/history/rpc.js';
import type { BoxRegistration } from '../src/types.js';

const S = 'aaaaaaaa-1111-2222-3333-444444444444';

function reg(over: Partial<BoxRegistration> = {}): BoxRegistration {
  return {
    boxId: 'box-1',
    name: 'smoke',
    token: 'box-token-0123456789',
    ...over,
  } as BoxRegistration;
}

function sinkRecorder(): {
  frames: HistoryFrame[];
  ingest(f: HistoryFrame): Promise<HistoryIngestResult>;
} {
  const frames: HistoryFrame[] = [];
  return {
    frames,
    ingest: async (f) => {
      frames.push(f);
      return {
        ok: true,
        offset: f.offset + Buffer.from(f.data, 'base64').length,
        sha256: f.sha256,
      };
    },
  };
}

const frame = (data: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  origin: { boxId: 'spoofed-box' },
  agent: 'claude',
  path: `projects/-workspace/${S}.jsonl`,
  offset: 0,
  sha256Prefix: '',
  sha256: 'h',
  data: Buffer.from(data).toString('base64'),
  ...over,
});

describe('parseFrame', () => {
  it('refuses traversal, absolute paths and malformed fields', () => {
    expect(parseFrame(frame('x'))).not.toBeNull();
    expect(parseFrame(frame('x', { path: '/etc/passwd' }))).toBeNull();
    expect(parseFrame(frame('x', { path: 'projects/../../x' }))).toBeNull();
    expect(parseFrame(frame('x', { offset: -1 }))).toBeNull();
    expect(parseFrame(frame('x', { data: 5 }))).toBeNull();
  });
});

describe('HistoryRelay', () => {
  const base = {
    listBoxes: async () => [],
    log: () => {},
    hostSecrets: async () => ['hub-secret-0123456789'],
  };

  it('takes the origin from the box registration, never from the frame', async () => {
    const sink = sinkRecorder();
    const relay = new HistoryRelay({ ...base, sink, captureEnabled: async () => true });
    const r = await relay.chunk(reg({ kind: 'cloud', backend: 'e2b' }), frame('{"a":1}\n'));
    expect(r.ok).toBe(true);
    expect(sink.frames[0]!.origin).toMatchObject({
      boxId: 'box-1',
      boxName: 'smoke',
      provider: 'e2b',
    });
  });

  it("redacts the host's exact secrets before the sink, length-preserving", async () => {
    const sink = sinkRecorder();
    const relay = new HistoryRelay({ ...base, sink, captureEnabled: async () => true });
    const text = '{"out":"hub-secret-0123456789"}\n';
    await relay.chunk(reg({ kind: 'cloud' }), frame(text));
    const got = Buffer.from(sink.frames[0]!.data, 'base64').toString();
    expect(got).not.toContain('hub-secret-0123456789');
    expect(got.length).toBe(text.length);
  });

  it('answers disabled when the project opted out, and never reaches the sink', async () => {
    const sink = sinkRecorder();
    const relay = new HistoryRelay({ ...base, sink, captureEnabled: async () => false });
    expect(await relay.chunk(reg({ kind: 'cloud' }), frame('x\n'))).toMatchObject({
      ok: false,
      code: 'disabled',
    });
    expect((await relay.config(reg({ kind: 'cloud' }))).enabled).toBe(false);
    expect(sink.frames).toHaveLength(0);
  });

  it('tells a docker box ctl not to ship (the relay does) and a cloud box to ship claude', async () => {
    const relay = new HistoryRelay({
      ...base,
      sink: sinkRecorder(),
      captureEnabled: async () => true,
    });
    const docker = await relay.config(reg({ containerName: 'agentbox-smoke' }));
    expect(docker.enabled).toBe(false);
    // ...but its ctl still runs the row cursor for sqlite-backed agents.
    expect(docker.materialize?.map((a) => a.agent)).toEqual(['opencode']);
    const cloud = await relay.config(reg({ kind: 'cloud', backend: 'hetzner' }));
    expect(cloud.enabled).toBe(true);
    expect(cloud.agents.map((a) => a.agent).sort()).toEqual(['claude', 'codex', 'opencode', 'pi']);
    expect(cloud.credentialFiles).toContain('/home/vscode/.claude/.credentials.json');
  });

  /** A fake docker CLI over an in-memory box filesystem, counting calls. */
  function fakeDocker(files: Record<string, string>, state = 'running') {
    const calls: string[][] = [];
    const quoted = (script: string): string[] =>
      [...script.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    const run = async (args: string[]): Promise<Buffer> => {
      calls.push(args);
      if (args[0] === 'inspect') return Buffer.from(`${state}\n`);
      if (args[0] === 'ps' || args[0] === 'rm') return Buffer.from('');
      const script = args[args.length - 1]!;
      if (script.includes('@@agentbox-history-scan@@')) {
        const [log, ...roots] = quoted(script).filter((q) => q.startsWith('/'));
        const listing = Object.entries(files)
          .filter(([p]) => roots.some((r) => p.startsWith(`${r}/`)))
          .map(([p, v]) => `${String(v.length)} ${p}`)
          .join('\n');
        return Buffer.from(`${files[log!] ?? ''}\n@@agentbox-history-scan@@\n${listing}\n`);
      }
      const path = quoted(script)[0] ?? '';
      if (script.startsWith('cat ')) return Buffer.from(files[path] ?? '');
      if (script.startsWith('stat '))
        return Buffer.from(files[path] ? String(files[path]!.length) : '');
      if (script.startsWith('ls ')) return Buffer.from('');
      const m = /tail -c \+(\d+) .* head -c (\d+)/.exec(script)!;
      return Buffer.from(
        (files[path] ?? '').slice(Number(m[1]) - 1, Number(m[1]) - 1 + Number(m[2])),
      );
    };
    return { calls, run };
  }

  const LOG = '/home/vscode/.local/state/agentbox/history-bindings.jsonl';
  const transcript = (id: string): string => `/home/vscode/.claude/projects/-workspace/${id}.jsonl`;
  const bind = (id: string, boxId = 'box-1'): string =>
    `${JSON.stringify({ ts: 't', boxId, agent: 'claude', sessionId: id })}\n`;

  it('ships a docker box from its binding log over docker exec', async () => {
    const sink = sinkRecorder();
    const files: Record<string, string> = {
      [LOG]: bind(S),
      [transcript(S)]: '{"a":1}\n{"b":2}\n',
    };
    const docker = fakeDocker(files);
    const box = reg({ containerName: 'agentbox-smoke' });
    const relay = new HistoryRelay({
      ...base,
      listBoxes: async () => [box],
      sink,
      dockerRun: docker.run,
      captureEnabled: async () => true,
    });
    await relay.tick();
    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0]!.origin).toMatchObject({ boxId: 'box-1', provider: 'docker' });
    expect(Buffer.from(sink.frames[0]!.data, 'base64').toString()).toBe('{"a":1}\n{"b":2}\n');
    expect(docker.calls.every((c) => c[0] !== 'exec' || (c[1] === '-u' && c[2] === 'vscode'))).toBe(
      true,
    );
    expect((await relay.flushBox('box-1'))?.frames).toBe(0);
  });

  it('costs one inspect + one exec per idle pass, whatever the number of sessions (B2)', async () => {
    const sink = sinkRecorder();
    const ids = Array.from(
      { length: 10 },
      (_, i) => `${String(i).padStart(8, '0')}-1111-2222-3333-444444444444`,
    );
    const files: Record<string, string> = { [LOG]: ids.map((id) => bind(id)).join('') };
    for (const id of ids) {
      files[transcript(id)] = '{"a":1}\n';
      for (let k = 0; k < 7; k++) {
        files[`/home/vscode/.claude/projects/-workspace/${id}/subagents/agent-${String(k)}.jsonl`] =
          '{"s":1}\n';
      }
    }
    const docker = fakeDocker(files);
    const relay = new HistoryRelay({
      ...base,
      listBoxes: async () => [reg({ containerName: 'agentbox-smoke' })],
      sink,
      dockerRun: docker.run,
      captureEnabled: async () => true,
    });
    await relay.tick();
    expect(sink.frames).toHaveLength(80);
    docker.calls.length = 0;
    await relay.tick();
    expect(docker.calls.map((c) => c[0])).toEqual(['inspect', 'exec']);
    // One file grows: exactly one extra read.
    files[transcript(ids[3]!)] = '{"a":1}\n{"a":2}\n';
    docker.calls.length = 0;
    await relay.tick();
    expect(docker.calls.map((c) => c[0])).toEqual(['inspect', 'exec', 'exec']);
    expect(sink.frames).toHaveLength(81);
  });

  it('ignores binding lines another box wrote (a checkpoint carried them, B1)', async () => {
    const sink = sinkRecorder();
    const other = 'eeeeeeee-1111-2222-3333-444444444444';
    const files: Record<string, string> = {
      [LOG]: bind(other, 'source-box') + bind(S),
      [transcript(S)]: '{"a":1}\n',
      [transcript(other)]: '{"x":1}\n',
    };
    const docker = fakeDocker(files);
    const relay = new HistoryRelay({
      ...base,
      listBoxes: async () => [reg({ containerName: 'agentbox-smoke' })],
      sink,
      dockerRun: docker.run,
      captureEnabled: async () => true,
    });
    await relay.tick();
    expect(sink.frames.map((f) => f.path)).toEqual([`projects/-workspace/${S}.jsonl`]);
  });

  it('labels flush helpers and removes them on settle, then never reads the box again', async () => {
    const files: Record<string, string> = { [LOG]: bind(S), [transcript(S)]: '{"a":1}\n' };
    const docker = fakeDocker(files, 'paused');
    const box = reg({ containerName: 'agentbox-smoke' });
    const relay = new HistoryRelay({
      ...base,
      listBoxes: async () => [box],
      sink: sinkRecorder(),
      dockerRun: docker.run,
      captureEnabled: async () => true,
    });
    await relay.flushBox('box-1');
    const helper = docker.calls.find((c) => c[0] === 'run')!;
    expect(helper).toContain('agentbox.history-helper=agentbox-smoke');
    docker.calls.length = 0;
    await relay.settleBox('box-1');
    expect(docker.calls.map((c) => c[0])).toEqual(['ps']);
    expect(docker.calls[0]).toContain('label=agentbox.history-helper=agentbox-smoke');
    docker.calls.length = 0;
    await relay.tick();
    expect(await relay.flushBox('box-1')).toBeNull();
    expect(docker.calls.filter((c) => c[0] !== 'inspect')).toEqual([]);
  });
});

describe('runHistoryRpc without a hub', () => {
  it('answers disabled with exit 0 so the shipper can tell it from a transport error', async () => {
    const r = await runHistoryRpc(null, null, reg(), 'history.chunk', {});
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: 'disabled' });
  });
});

describe('untarSingleFile', () => {
  it('extracts the one file of a docker cp tar stream', () => {
    const body = Buffer.from('hello\n');
    const header = Buffer.alloc(512);
    header.write('history-bindings.jsonl', 0, 'latin1');
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
    const tar = Buffer.concat([header, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]);
    expect(untarSingleFile(tar)?.toString()).toBe('hello\n');
  });
});

describe('removeHistoryHelpers', () => {
  it('force-removes every helper still labelled for the container', async () => {
    const calls: string[][] = [];
    await removeHistoryHelpers('agentbox-x', async (args) => {
      calls.push(args);
      return Buffer.from(args[0] === 'ps' ? 'abc123\ndef456\n' : '');
    });
    expect(calls[1]).toEqual(['rm', '-f', 'abc123', 'def456']);
  });
});
