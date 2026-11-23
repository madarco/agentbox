import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runMcpStdioBridge } from '@agentbox/core';
import { hubMcpForward } from '../src/commands/mcp.js';

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function fakeHub(): Promise<{ url: string; seen: Array<{ auth?: string; body: unknown }> }> {
  const seen: Array<{ auth?: string; body: unknown }> = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as { id?: number };
      seen.push({ auth: req.headers.authorization, body });
      if (req.url !== '/api/mcp') {
        res.statusCode = 404;
        res.end();
      } else if (body.id === undefined) {
        res.statusCode = 202;
        res.end();
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
      }
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${String((server!.address() as AddressInfo).port)}/`, seen };
}

describe('agentbox mcp (PC stdio proxy)', () => {
  it('posts each message to <hub>/api/mcp with the credential it was given at run time', async () => {
    const hub = await fakeHub();
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (c: Buffer) => (out += c.toString()));
    const done = runMcpStdioBridge({
      input,
      output,
      forward: hubMcpForward({ url: hub.url, apiKey: 'k-123' }),
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.end();
    await done;
    expect(
      out
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
    expect(hub.seen.map((s) => s.auth)).toEqual(['Bearer k-123', 'Bearer k-123']);
  });
});
