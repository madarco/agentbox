import { describe, expect, it } from 'vitest';
import { handleStoreRpcRequest } from '../src/store/store-rpc-routes.js';
import { MemoryStore } from '../src/store/memory-store.js';

const ADMIN = 'admin-secret';

function req(over: Partial<Parameters<typeof handleStoreRpcRequest>[0]>) {
  return { method: 'POST', path: '/admin/store', bearer: ADMIN, bodyText: '', ...over };
}

describe('handleStoreRpcRequest', () => {
  it('returns null for non-store paths (router falls through)', async () => {
    const res = await handleStoreRpcRequest(req({ path: '/events' }), { store: new MemoryStore(), adminToken: ADMIN });
    expect(res).toBeNull();
  });

  it('fail-closes 503 when the admin token is unset', async () => {
    const res = await handleStoreRpcRequest(req({ bearer: '' }), { store: new MemoryStore(), adminToken: '' });
    expect(res?.status).toBe(503);
  });

  it('401s a wrong bearer', async () => {
    const res = await handleStoreRpcRequest(req({ bearer: 'nope' }), { store: new MemoryStore(), adminToken: ADMIN });
    expect(res?.status).toBe(401);
  });

  it('405s a non-POST', async () => {
    const res = await handleStoreRpcRequest(req({ method: 'GET' }), { store: new MemoryStore(), adminToken: ADMIN });
    expect(res?.status).toBe(405);
  });

  it('400s a malformed body', async () => {
    const res = await handleStoreRpcRequest(
      req({ bodyText: JSON.stringify({ method: 'listBoxes' }) }),
      { store: new MemoryStore(), adminToken: ADMIN },
    );
    expect(res?.status).toBe(400);
  });

  it('400s an unknown store op (allow-list)', async () => {
    const res = await handleStoreRpcRequest(
      req({ bodyText: JSON.stringify({ method: 'dropTables', args: [] }) }),
      { store: new MemoryStore(), adminToken: ADMIN },
    );
    expect(res?.status).toBe(400);
  });

  it('dispatches an allow-listed op and returns its result', async () => {
    const store = new MemoryStore();
    await store.registerBox({ boxId: 'b1', token: 't', name: 'b1', registeredAt: new Date().toISOString() });
    const res = await handleStoreRpcRequest(
      req({ bodyText: JSON.stringify({ method: 'listBoxes', args: [] }) }),
      { store, adminToken: ADMIN },
    );
    expect(res?.status).toBe(200);
    const result = (res?.body as { result: Array<{ boxId: string }> }).result;
    expect(result.map((b) => b.boxId)).toEqual(['b1']);
  });

  it('dispatches listStatuses (promoted to the interface)', async () => {
    const store = new MemoryStore();
    await store.setStatus('b1', 'b1', 1, { schema: 1, boxId: 'b1', phase: 'ready' });
    const res = await handleStoreRpcRequest(
      req({ bodyText: JSON.stringify({ method: 'listStatuses', args: [] }) }),
      { store, adminToken: ADMIN },
    );
    expect(res?.status).toBe(200);
    const result = (res?.body as { result: Array<{ boxId: string }> }).result;
    expect(result.map((s) => s.boxId)).toEqual(['b1']);
  });
});
