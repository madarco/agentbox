import { describe, expect, it } from 'vitest';
import { handleRelayRequest, type ControlPlaneDeps } from '../src/core/handler.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { RemoteStore } from '../src/store/remote-store.js';
import { runStoreConformance } from './store-conformance-suite.js';

const ADMIN = 'admin-tok';

/**
 * RemoteStore conformance: route its admin-bearer `POST /admin/store` calls,
 * in-process (no network), through the real hosted-plane handler onto a fresh
 * backing MemoryStore. Exercises the full client → /admin/store → applyStoreOp
 * → Store round-trip + JSON (de)serialization.
 */
runStoreConformance('RemoteStore', () => {
  const backing = new MemoryStore();
  const deps: ControlPlaneDeps = { store: backing, leaser: null, adminToken: ADMIN };
  const fetchImpl = (async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = new URL(String(url));
    const auth = init?.headers?.Authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const res = await handleRelayRequest(
      {
        method: init?.method ?? 'GET',
        path: u.pathname,
        query: u.searchParams,
        bearer: m ? m[1]! : '',
        bodyText: init?.body ?? '',
      },
      deps,
    );
    return new Response(res.body == null ? null : JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof fetch;
  return Promise.resolve(new RemoteStore({ baseUrl: 'http://plane.test', adminToken: ADMIN, fetchImpl }));
});

describe('RemoteStore auth', () => {
  it('a wrong admin token is rejected (401 → throws)', async () => {
    const backing = new MemoryStore();
    const deps: ControlPlaneDeps = { store: backing, leaser: null, adminToken: ADMIN };
    const fetchImpl = (async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const u = new URL(String(url));
      const auth = init?.headers?.Authorization ?? '';
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      const res = await handleRelayRequest(
        { method: init?.method ?? 'GET', path: u.pathname, query: u.searchParams, bearer: m ? m[1]! : '', bodyText: init?.body ?? '' },
        deps,
      );
      return new Response(res.body == null ? null : JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof fetch;
    const store = new RemoteStore({ baseUrl: 'http://plane.test', adminToken: 'wrong', fetchImpl });
    await expect(store.countBoxes()).rejects.toThrow(/401/);
  });
});
