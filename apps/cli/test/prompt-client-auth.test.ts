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
    if ((req.url ?? '').endsWith('/stream')) {
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

/** A server that answers every request with `status`, counting the attempts. */
async function statusServer(
  status: number,
  servers: Array<() => Promise<void>>,
): Promise<{ port: number; hits: () => number }> {
  let count = 0;
  const server = createServer((_req, res) => {
    count += 1;
    res.writeHead(status).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  servers.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  );
  return { port: (server.address() as AddressInfo).port, hits: () => count };
}

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
    expect(hub.seen[0]?.url).toBe('/api/v1/boxes/box-1/stream');
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

  it('gives up on a 401 and reports it', async () => {
    // The attach footer relies on this: the client gives up permanently on a
    // credential rejection, so if `onError` were not raised the footer would sit
    // silent all session while the box is blocked, looking exactly like "no
    // approvals". `fatal` is what lets the footer band it.
    const { port, hits } = await statusServer(401, servers);

    const errors: Array<{ message: string; fatal: boolean }> = [];
    streams.push(
      subscribePrompts({
        hubBaseUrl: `http://127.0.0.1:${String(port)}`,
        hubApiKey: 'stale',
        boxId: 'box-401',
        onPrompt: () => {},
        onResolved: () => {},
        onError: (e, fatal) => errors.push({ message: e.message, fatal }),
      }),
    );
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('401');
    expect(errors[0]?.fatal).toBe(true);
    expect(hits()).toBe(1); // gave up; never retried
  });

  it('retries a 503 instead of giving up, and reports it non-fatally', async () => {
    // A hub restart (`agentbox hub update`) makes its reverse proxy answer 5xx
    // for as long as the container is being replaced. Treating that like a
    // credential error left the footer permanently dead, with detach/reattach as
    // the only cure — the regression this pins.
    const { port, hits } = await statusServer(503, servers);

    const errors: Array<{ message: string; fatal: boolean }> = [];
    streams.push(
      subscribePrompts({
        hubBaseUrl: `http://127.0.0.1:${String(port)}`,
        boxId: 'box-503',
        onPrompt: () => {},
        onResolved: () => {},
        onError: (e, fatal) => errors.push({ message: e.message, fatal }),
      }),
    );
    // Longer than `settle`: the first backoff is the 200ms base jittered down to
    // 100-200ms, so a 120ms window can miss the retry entirely.
    await new Promise((r) => setTimeout(r, 600));

    expect(hits()).toBeGreaterThan(1); // kept trying
    // Reported once for the outage, not once per attempt.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fatal).toBe(false);
  });

  it('resyncs after a mid-frame drop (the parse buffer does not leak across connects)', async () => {
    // The hub can vanish mid-event when its container is replaced. The leftover
    // partial frame used to be concatenated onto the next connection's `open`,
    // parsing as one garbage event — so `onReconnect` never fired and a prompt
    // answered during the outage stayed pinned forever, which is the exact
    // failure this client's resync exists to prevent.
    let conn = 0;
    const server = createServer((_req, res) => {
      conn += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (conn === 1) {
        res.write('event: open\ndata: {}\n\n');
        res.write('event: box-status\ndata: {"schema":1'); // truncated: no \n\n
        // Let those reach the client before killing the socket — destroying
        // synchronously discards the buffered writes, and then there is no
        // leftover partial frame to regress on.
        setTimeout(() => res.destroy(), 50);
        return;
      }
      res.write('event: open\ndata: {}\n\n'); // held open
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

    let reconnects = 0;
    streams.push(
      subscribePrompts({
        hubBaseUrl: `http://127.0.0.1:${String(port)}`,
        boxId: 'box-drop',
        onPrompt: () => {},
        onResolved: () => {},
        onReconnect: () => {
          reconnects += 1;
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 600));

    expect(conn).toBeGreaterThan(1); // it did reconnect
    expect(reconnects).toBeGreaterThan(0); // and told the caller to resync
  });

  it('omits the header on the answer POST without a key', async () => {
    const hub = await hubStub();
    servers.push(hub.close);

    await postAnswer({ hubBaseUrl: hub.url, body: { id: 'p2', answer: 'n' } });

    expect(hub.seen[0]?.auth).toBeUndefined();
  });
});
