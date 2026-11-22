import { describe, expect, it } from 'vitest';
import type { HistoryFrame, HistoryIngestResult } from '@agentbox/core';
import { parseHistoryFrame as parseFrame } from '@agentbox/core';
import { HistoryRelay } from '../src/history/history-relay.js';
import { untarSingleFile } from '../src/history/docker-source.js';
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
    expect((await relay.config(reg({ containerName: 'agentbox-smoke' }))).enabled).toBe(false);
    const cloud = await relay.config(reg({ kind: 'cloud', backend: 'hetzner' }));
    expect(cloud.enabled).toBe(true);
    expect(cloud.agents.map((a) => a.agent)).toContain('claude');
    expect(cloud.credentialFiles).toContain('/home/vscode/.claude/.credentials.json');
  });

  it('ships a docker box from its binding log over docker exec', async () => {
    const sink = sinkRecorder();
    const files: Record<string, string> = {
      '/home/vscode/.local/state/agentbox/history-bindings.jsonl': `{"ts":"t","agent":"claude","sessionId":"${S}"}\n`,
      [`/home/vscode/.claude/projects/-workspace/${S}.jsonl`]: '{"a":1}\n{"b":2}\n',
    };
    const calls: string[][] = [];
    const dockerRun = async (args: string[]): Promise<Buffer> => {
      calls.push(args);
      if (args[0] === 'inspect') return Buffer.from('running\n');
      const script = args[args.length - 1]!;
      const path = /'([^']+)'/.exec(script)?.[1] ?? '';
      if (script.startsWith('cat ')) return Buffer.from(files[path] ?? '');
      if (script.startsWith('stat '))
        return Buffer.from(files[path] ? String(files[path]!.length) : '');
      if (script.startsWith('ls ')) return Buffer.from('');
      const m = /tail -c \+(\d+) .* head -c (\d+)/.exec(script)!;
      return Buffer.from(
        (files[path] ?? '').slice(Number(m[1]) - 1, Number(m[1]) - 1 + Number(m[2])),
      );
    };
    const box = reg({ containerName: 'agentbox-smoke' });
    const relay = new HistoryRelay({
      ...base,
      listBoxes: async () => [box],
      sink,
      dockerRun,
      captureEnabled: async () => true,
    });
    await relay.tick();
    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0]!.origin).toMatchObject({ boxId: 'box-1', provider: 'docker' });
    expect(Buffer.from(sink.frames[0]!.data, 'base64').toString()).toBe('{"a":1}\n{"b":2}\n');
    expect(calls.every((c) => c[0] !== 'exec' || (c[1] === '-u' && c[2] === 'vscode'))).toBe(true);
    expect((await relay.flushBox('box-1'))?.frames).toBe(0);
  });
});

describe('runHistoryRpc without a hub', () => {
  it('answers disabled with exit 0 so the shipper can tell it from a transport error', async () => {
    const r = await runHistoryRpc(null, reg(), 'history.chunk', {});
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
