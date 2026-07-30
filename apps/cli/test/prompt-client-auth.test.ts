import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { postAnswer, subscribePrompts } from '../src/wrapped-pty/prompt-client.js';

/**
 * The attach footer talks to the local hub's `/api/v1` for a normal box, but to
 * the box's control box when it registered with one — and `/api/v1` is gated by
 * the hub API key (a Bearer). These pin that the header is actually sent (and
 * omitted when there's no key), and that the routes hit are the `/api/v1` ones.
 */

interface Captured {
  url: string;
  auth: string | undefined;
}

function hubStub(): Promise<{
  url: string;
  seen: Captured[];
  close: () => Promise<void>;
}> {
  const seen: Captured[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    if ((req.url ?? '').includes('/prompts/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: open\ndata: {}\n\n');
      return; // held open, like the real SSE route
    }
    req.resume();
    // The v1 answer route returns 200 {ok:true} (not the relay's 204).
    req.on('end', () =>
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        seen,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 120));

describe('prompt-client auth', () => {
  const streams: Array<{ close: () => void }> = [];
  const servers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const s of streams.splice(0)) s.close();
    for (const c of servers.splice(0)) await c();
  });

  it('subscribes to the per-box v1 stream and sends the bearer when hubApiKey is set', async () => {
    const hub = await hubStub();
    servers.push(hub.close);

    streams.push(
      subscribePrompts({
        hubBaseUrl: hub.url,
        hubApiKey: 'plane-key',
        boxId: 'box-1',
        onPrompt: () => {},
        onResolved: () => {},
      }),
    );
    await settle();

    expect(hub.seen).toHaveLength(1);
    expect(hub.seen[0]?.url).toBe('/api/v1/boxes/box-1/prompts/stream');
    expect(hub.seen[0]?.auth).toBe('Bearer plane-key');
  });

  it('omits the header on the subscribe when no key is set', async () => {
    const hub = await hubStub();
    servers.push(hub.close);

    streams.push(
      subscribePrompts({
        hubBaseUrl: hub.url,
        boxId: 'box-2',
        onPrompt: () => {},
        onResolved: () => {},
      }),
    );
    await settle();

    expect(hub.seen[0]?.auth).toBeUndefined();
  });

  it('answers on the v1 route (id in the path) and sends the bearer when set', async () => {
    const hub = await hubStub();
    servers.push(hub.close);

    const res = await postAnswer({
      hubBaseUrl: hub.url,
      hubApiKey: 'plane-key',
      body: { id: 'p1', answer: 'y' },
    });

    expect(res.ok).toBe(true);
    expect(hub.seen[0]?.url).toBe('/api/v1/approvals/p1/answer');
    expect(hub.seen[0]?.auth).toBe('Bearer plane-key');
  });

  it('reports a non-200 SSE response instead of retrying it away', async () => {
    // The attach footer relies on this: the client gives up permanently on a
    // non-200 (e.g. the hub rejecting a stale API key with 401), so if `onError`
    // were not raised the footer would sit silent all session while the box is
    // blocked, looking exactly like "no approvals".
    const server = createServer((_req, res) => {
      res.writeHead(401).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    servers.push(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
    );

    const errors: string[] = [];
    streams.push(
      subscribePrompts({
        hubBaseUrl: `http://127.0.0.1:${String(port)}`,
        hubApiKey: 'stale',
        boxId: 'box-401',
        onPrompt: () => {},
        onResolved: () => {},
        onError: (e) => errors.push(e.message),
      }),
    );
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('401');
  });

  it('omits the header on the answer POST without a key', async () => {
    const hub = await hubStub();
    servers.push(hub.close);

    await postAnswer({ hubBaseUrl: hub.url, body: { id: 'p2', answer: 'n' } });

    expect(hub.seen[0]?.auth).toBeUndefined();
  });
});
