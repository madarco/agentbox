import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';
import { HostReachPoller } from '../src/host-reach-poller.js';
import { SseFrameReader } from '../src/sse-read.js';

/**
 * The stream transport, and — the part that actually protects users — its
 * fallback. A machine behind a proxy that buffers event streams must keep
 * working, not go quiet, so every "the stream isn't usable" shape is exercised
 * against a real socket rather than a mock.
 */

const ADMIN = 'admin-token';

describe('SseFrameReader', () => {
  it('reassembles a frame split across chunks', () => {
    const r = new SseFrameReader();
    expect(r.push('event: action\nda')).toEqual([]);
    expect(r.push('ta: {"id":"1"}\n\n')).toEqual([{ event: 'action', data: '{"id":"1"}' }]);
  });

  it('drops comment keep-alives and the connect preamble', () => {
    const r = new SseFrameReader();
    expect(r.push(': connected\n\n')).toEqual([]);
    expect(r.push(': ping\n\nevent: action\ndata: {}\n\n')).toEqual([
      { event: 'action', data: '{}' },
    ]);
  });

  it('reads several frames from one chunk, in order', () => {
    const r = new SseFrameReader();
    const frames = r.push('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
    expect(frames).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('joins multi-line data and defaults the event name', () => {
    const r = new SseFrameReader();
    expect(r.push('data: one\ndata: two\n\n')).toEqual([{ event: 'message', data: 'one\ntwo' }]);
  });

  it('forgets a torn frame on reset, so a reconnect cannot splice two halves', () => {
    const r = new SseFrameReader();
    r.push('event: action\ndata: {"hal');
    r.reset();
    // The orphaned tail carries no `data:` field, so it yields nothing at all —
    // rather than being glued onto the next frame and parsed as half an action.
    expect(r.push('f":true}\n\n')).toEqual([]);
    expect(r.push('event: action\ndata: {"ok":true}\n\n')).toEqual([
      { event: 'action', data: '{"ok":true}' },
    ]);
  });
});

describe('the control box event stream', () => {
  let handle: RelayServerHandle;

  beforeEach(async () => {
    handle = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      controlPlane: true,
      adminToken: ADMIN,
      hostReachTimeoutMs: 2_000,
    });
    const port = (handle.server.address() as AddressInfo).port;
    await fetch(`http://127.0.0.1:${String(port)}/admin/register-box`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boxId: 'b1',
        token: 't1',
        name: 'cpbox',
        kind: 'cloud',
        backend: 'e2b',
      }),
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  function url(path: string): string {
    return `http://127.0.0.1:${String((handle.server.address() as AddressInfo).port)}${path}`;
  }

  it('pushes a parked action to a connected machine', async () => {
    const res = await fetch(url('/admin/hostreach/events?poller=p1'), {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const frames = new SseFrameReader();
    // The preamble proves the response is flowing before any work exists.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(': connected');

    void fetch(url('/rpc'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t1' },
      body: JSON.stringify({ method: 'cp.fromHost', params: { sources: ['./a'], dest: '/w/' } }),
    });

    let action: { id: string; method: string } | undefined;
    while (!action) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const f of frames.push(new TextDecoder().decode(chunk.value))) {
        if (f.event === 'action') action = JSON.parse(f.data) as { id: string; method: string };
      }
    }
    expect(action?.method).toBe('cp.fromHost');
    await reader.cancel();
  });

  it('refuses a stream without the admin bearer', async () => {
    const res = await fetch(url('/admin/hostreach/events?poller=p1'), {
      headers: { Authorization: 'Bearer t1' },
    });
    expect(res.status).toBe(401);
    await res.text();
  });

  it('requires a poller identity, which the ownership rules depend on', async () => {
    const res = await fetch(url('/admin/hostreach/events'), {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(400);
    await res.text();
  });
});

describe('the client transport choice', () => {
  let stub: Server;
  let base: string;
  const log: string[] = [];

  afterEach(async () => {
    log.length = 0;
    await new Promise<void>((r) => stub.close(() => r()));
  });

  /** Stand in for a control box whose event route behaves in a given way. */
  async function startStub(
    events: (res: import('node:http').ServerResponse) => void,
  ): Promise<void> {
    stub = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/admin/hostreach/events')) {
        events(res);
        return;
      }
      // The poll route answers immediately with nothing, so the loop spins
      // harmlessly while a test observes which transport it chose.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ actions: [] }));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${String((stub.address() as AddressInfo).port)}`;
  }

  function poller(): HostReachPoller {
    return new HostReachPoller({
      controlPlaneUrl: base,
      adminToken: ADMIN,
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      logger: (line) => log.push(line),
    });
  }

  async function until(pred: () => boolean, ms = 8_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`condition not met; log:\n${log.join('\n')}`);
  }

  it('streams when the control box serves an event stream', async () => {
    await startStub((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
    });
    const p = poller();
    p.start();
    await until(() => log.some((l) => l.includes('streaming host actions')));
    await p.stop();
  });

  it('falls back to polling against a control box with no event route', async () => {
    // The compatibility case: an older hub 404s, and the machine must keep
    // working rather than sit silent.
    await startStub((res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const p = poller();
    p.start();
    await until(() => log.some((l) => l.includes('has no event stream')));
    await until(() => log.some((l) => l.includes('long polling')));
    await p.stop();
  });

  it('falls back when a proxy answers 200 with something that is not a stream', async () => {
    await startStub((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"actions":[]}');
    });
    const p = poller();
    p.start();
    await until(() => log.some((l) => l.includes('did not come through')));
    await until(() => log.some((l) => l.includes('long polling')));
    await p.stop();
  });
});
