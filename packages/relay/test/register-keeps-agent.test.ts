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

  it('a claude box with an added openclaw keeps the gateway across every re-register', async () => {
    const reg = { boxId: 'b4', token: 't4', name: 'both', agent: 'claude' };
    await post('/admin/register-box', { ...reg, agents: ['claude', 'openclaw'] });
    expect(await services('t4')).toEqual(['openclaw']);
    // A re-register that sends only the primary agent (an older caller).
    await post('/admin/register-box', reg);
    expect(await services('t4')).toEqual(['openclaw']);
    expect((await handle.store.getBox('b4'))?.agents).toEqual(['claude', 'openclaw']);
  });

  it("a re-register from another PC's older record (agents [claude]) does not drop openclaw", async () => {
    const reg = { boxId: 'b6', token: 't6', name: 'both', agent: 'claude' };
    await post('/admin/register-box', { ...reg, agents: ['claude', 'openclaw'] });
    await post('/admin/register-box', { ...reg, agents: ['claude'] });
    expect(await services('t6')).toEqual(['openclaw']);
    // An older hub's addBoxAgent swapped `agent` instead of listing both.
    await post('/admin/register-box', { boxId: 'b7', token: 't7', name: 'old', agent: 'openclaw' });
    await post('/admin/register-box', {
      boxId: 'b7',
      token: 't7',
      name: 'old',
      agent: 'claude',
      agents: ['claude'],
    });
    expect(await services('t7')).toEqual(['openclaw']);
  });

  it('keeps originUrl and repoKey across a re-register that omits them', async () => {
    await post('/admin/register-box', {
      boxId: 'b5',
      token: 't5',
      name: 'r',
      originUrl: 'git@github.com:o/r.git',
      repoKey: 'github.com/o/r',
    });
    await post('/admin/register-box', { boxId: 'b5', token: 't5', name: 'r' });
    expect(await handle.store.getBox('b5')).toMatchObject({
      originUrl: 'git@github.com:o/r.git',
      repoKey: 'github.com/o/r',
    });
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

describe('/admin/register-box and llmProxy (#446 review B1)', () => {
  let handle: RelayServerHandle;
  const post = async (body: unknown) => {
    const port = (handle.server.address() as AddressInfo).port;
    await fetch(`http://127.0.0.1:${String(port)}/admin/register-box`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };
  beforeEach(async () => {
    handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
  });
  afterEach(async () => {
    await handle.close();
  });
  const llmProxy = { mode: 'forward', upstream: 'hub.example.com:8790' };

  it('stores it, and keeps it across a re-register that omits it', async () => {
    await post({ boxId: 'b1', token: 't1', name: 'p', llmProxy });
    expect((await handle.store.getBox('b1'))?.llmProxy).toEqual(llmProxy);
    await post({ boxId: 'b1', token: 't1', name: 'p' });
    expect((await handle.store.getBox('b1'))?.llmProxy).toEqual(llmProxy);
  });
  it('drops a malformed one (not host:port, not forward)', async () => {
    await post({
      boxId: 'b2',
      token: 't2',
      name: 'p',
      llmProxy: { mode: 'forward', upstream: 'a;b' },
    });
    expect((await handle.store.getBox('b2'))?.llmProxy).toBeUndefined();
    await post({
      boxId: 'b3',
      token: 't3',
      name: 'p',
      llmProxy: { mode: 'reverse', upstream: 'h:1' },
    });
    expect((await handle.store.getBox('b3'))?.llmProxy).toBeUndefined();
  });
});
