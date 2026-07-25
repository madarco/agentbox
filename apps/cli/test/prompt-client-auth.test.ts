import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { postAnswer, subscribePrompts } from '../src/wrapped-pty/prompt-client.js';

/**
 * The attach footer talks to the laptop's loopback relay for a normal box, but
 * to the box's control box when it registered with one — and that plane's admin
 * gate only passes a non-loopback caller with the admin bearer. These pin that
 * the header is actually sent (and omitted when there's no token).
 */

interface Captured {
  url: string;
  auth: string | undefined;
}

function relayStub(): Promise<{
  url: string;
  seen: Captured[];
  close: () => Promise<void>;
}> {
  const seen: Captured[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    if ((req.url ?? '').startsWith('/admin/prompts/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      return; // held open, like the real SSE route
    }
    req.resume();
    req.on('end', () => res.writeHead(204).end());
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

  it('sends the bearer on the SSE subscribe when authToken is set', async () => {
    const relay = await relayStub();
    servers.push(relay.close);

    streams.push(
      subscribePrompts({
        relayBaseUrl: relay.url,
        authToken: 'plane-token',
        boxId: 'box-1',
        onPrompt: () => {},
        onResolved: () => {},
      }),
    );
    await settle();

    expect(relay.seen).toHaveLength(1);
    expect(relay.seen[0]?.url).toContain('boxId=box-1');
    expect(relay.seen[0]?.auth).toBe('Bearer plane-token');
  });

  it('omits the header for the local relay (loopback needs no bearer)', async () => {
    const relay = await relayStub();
    servers.push(relay.close);

    streams.push(
      subscribePrompts({
        relayBaseUrl: relay.url,
        boxId: 'box-2',
        onPrompt: () => {},
        onResolved: () => {},
      }),
    );
    await settle();

    expect(relay.seen[0]?.auth).toBeUndefined();
  });

  it('sends the bearer on the answer POST when authToken is set', async () => {
    const relay = await relayStub();
    servers.push(relay.close);

    const res = await postAnswer({
      relayBaseUrl: relay.url,
      authToken: 'plane-token',
      body: { id: 'p1', answer: 'y' },
    });

    expect(res.ok).toBe(true);
    expect(relay.seen[0]?.url).toBe('/admin/prompts/answer');
    expect(relay.seen[0]?.auth).toBe('Bearer plane-token');
  });

  it('omits the header on the answer POST without a token', async () => {
    const relay = await relayStub();
    servers.push(relay.close);

    await postAnswer({ relayBaseUrl: relay.url, body: { id: 'p2', answer: 'n' } });

    expect(relay.seen[0]?.auth).toBeUndefined();
  });
});
