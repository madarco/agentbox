import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayClient } from '../src/relay-client.js';

/**
 * `RelayClient.post` had no coverage at all while it was fire-and-forget. It now
 * reports delivery, and the credentials watcher decides whether to retry from
 * that outcome — so the status handling here is load-bearing: read it wrong and
 * a rotated Claude token is either lost or resent every 15s forever.
 */
describe('RelayClient.post', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  /** Start a relay stand-in that answers every POST with `status`. */
  async function listen(
    status: number,
    opts: { body?: string; hang?: boolean } = {},
  ): Promise<{ client: RelayClient; received: Array<Record<string, unknown>> }> {
    const received: Array<Record<string, unknown>> = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          received.push(
            JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          );
        } catch {
          /* the malformed-body cases don't need to record */
        }
        if (opts.hang === true) return; // never answers — exercises the timeout
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(opts.body ?? '{}');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const client = new RelayClient({
      AGENTBOX_RELAY_URL: `http://127.0.0.1:${String(port)}`,
      AGENTBOX_RELAY_TOKEN: 'tok',
    });
    return { client, received };
  }

  it('reports 202 as delivered and sends the typed envelope', async () => {
    const { client, received } = await listen(202, { body: '{"ok":true,"accepted":true}' });
    expect(await client.post('credentials-updated', { agent: 'claude' })).toEqual({
      ok: true,
      status: 202,
    });
    expect(received[0]?.['type']).toBe('credentials-updated');
    expect(received[0]?.['payload']).toEqual({ agent: 'claude' });
  });

  // The relay answers 202 `{accepted:false}` when its newest-wins gate judges the
  // blob stale. That is delivery — only the status may decide.
  it('reports a 202 with accepted:false as delivered', async () => {
    const { client } = await listen(202, { body: '{"ok":true,"accepted":false}' });
    expect(await client.post('credentials-updated', {})).toEqual({ ok: true, status: 202 });
  });

  it('surfaces a 4xx status so the caller can stop retrying', async () => {
    const { client } = await listen(400, { body: '{"error":"missing type"}' });
    expect(await client.post('x', {})).toEqual({ ok: false, status: 400 });
  });

  it('surfaces a 5xx status so the caller retries', async () => {
    const { client } = await listen(500);
    expect(await client.post('x', {})).toEqual({ ok: false, status: 500 });
  });

  it('reports a null status when nothing is listening, and never rejects', async () => {
    // Port 1 on loopback: reliably refused, no listener to clean up.
    const client = new RelayClient({
      AGENTBOX_RELAY_URL: 'http://127.0.0.1:1',
      AGENTBOX_RELAY_TOKEN: 'tok',
    });
    await expect(client.post('x', {})).resolves.toEqual({ ok: false, status: null });
  });

  it('times out a hung relay rather than hanging the supervisor', async () => {
    const { client } = await listen(202, { hang: true });
    expect(await client.post('x', {}, { timeoutMs: 150 })).toEqual({ ok: false, status: null });
  });

  it('is a disabled no-op without a url + token', async () => {
    const client = new RelayClient({});
    expect(client.enabled).toBe(false);
    expect(await client.post('x', {})).toEqual({ ok: false, status: null });
  });
});
