import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';

/**
 * A classic cloud box (no control box) gets its `agents.list` answered by the
 * host's CloudBoxPoller, whose executor was built at /register. An agent added
 * to the running box (`agentbox openclaw <box>`) is a store-only registration
 * update, so the poller must read the CURRENT registration per action, or the
 * box keeps getting no units (review of #429's sign-off fixes, finding 1).
 */
describe('cloud poller answers agents.list from the current registration', () => {
  let relay: RelayServerHandle;
  let bridge: Server;
  let bridgeUrl: string;
  let pending: { id: string; method: string }[] = [];
  const results = new Map<string, { exitCode: number; stdout: string }>();
  const waiters = new Map<string, (r: { exitCode: number; stdout: string }) => void>();

  beforeEach(async () => {
    pending = [];
    results.clear();
    bridge = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/bridge/poll')) {
        const actions = pending.map((a) => ({
          ...a,
          boxId: 'cb1',
          params: {},
          createdAt: new Date().toISOString(),
        }));
        pending = [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ actions, events: [], status: null, cursor: 0 }));
        return;
      }
      if (req.method === 'POST' && req.url === '/bridge/action-result') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            id: string;
            exitCode: number;
            stdout: string;
          };
          results.set(body.id, body);
          waiters.get(body.id)?.(body);
          res.writeHead(200);
          res.end('{}');
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', r));
    bridgeUrl = `http://127.0.0.1:${String((bridge.address() as AddressInfo).port)}`;
    relay = await startRelayServer({ port: 0, host: '127.0.0.1' });
  });
  afterEach(async () => {
    await relay.close();
    await new Promise<void>((r) => bridge.close(() => r()));
  });

  const ask = (id: string): Promise<string[]> =>
    new Promise((resolve) => {
      waiters.set(id, (r) => {
        const payload = JSON.parse(r.stdout) as { agents: { id: string; service?: unknown }[] };
        resolve(payload.agents.filter((a) => a.service).map((a) => a.id));
      });
      pending.push({ id, method: 'agents.list' });
    });

  it('names an agent added to the store after the poller started', async () => {
    const port = (relay.server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${String(port)}/admin/register-box`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boxId: 'cb1',
        token: 't-cb1',
        name: 'nil',
        kind: 'cloud',
        backend: 'hetzner',
        previewUrl: bridgeUrl,
        bridgeToken: 'bt',
      }),
    });
    expect(res.status).toBeLessThan(300);
    expect(await ask('a1')).toEqual([]);

    const reg = await relay.store.getBox('cb1');
    await relay.store.registerBox({ ...reg!, agent: 'openclaw' });
    expect(await ask('a2')).toEqual(['openclaw']);
  }, 30_000);
});
