import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';

/**
 * A registration REPLACES the stored entry. A re-register from a record that
 * never learned the box's agent (a hub-built box's own record before the hub
 * worker passed it, a PC's adopt from before #429, `recover --adopt`) used to
 * strip it, and the box then got no service units (no openclaw gateway).
 */
describe('/admin/register-box keeps the agent across a re-register that omits it', () => {
  let handle: RelayServerHandle;
  const post = async (path: string, body: unknown, token?: string) => {
    const port = (handle.server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const services = async (token: string): Promise<string[]> => {
    const r = await post('/rpc', { method: 'agents.list', params: {} }, token);
    const payload = JSON.parse(String(r.body.stdout)) as {
      agents: { id: string; service?: unknown }[];
    };
    return payload.agents.filter((a) => a.service).map((a) => a.id);
  };

  beforeEach(async () => {
    handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
  });
  afterEach(async () => {
    await handle.close();
  });

  it('a re-register with no agent leaves an openclaw box its gateway', async () => {
    await post('/admin/register-box', {
      boxId: 'b1',
      token: 't1',
      name: 'claw',
      agent: 'openclaw',
    });
    expect(await services('t1')).toEqual(['openclaw']);
    // A start/rehydrate from a record that never learned the agent.
    await post('/admin/register-box', { boxId: 'b1', token: 't1', name: 'claw' });
    expect(await services('t1')).toEqual(['openclaw']);
  });

  it('still gives an agentless box no service units', async () => {
    await post('/admin/register-box', { boxId: 'b2', token: 't2', name: 'plain' });
    await post('/admin/register-box', { boxId: 'b2', token: 't2', name: 'plain' });
    expect(await services('t2')).toEqual([]);
  });

  it('a re-register naming an agent updates it', async () => {
    await post('/admin/register-box', { boxId: 'b3', token: 't3', name: 'x' });
    await post('/admin/register-box', { boxId: 'b3', token: 't3', name: 'x', agent: 'openclaw' });
    expect(await services('t3')).toEqual(['openclaw']);
  });
});
